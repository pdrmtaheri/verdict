// Codex through `codex app-server`: newline-delimited JSON-RPC 2.0 on stdio,
// on the local `codex` login. verdict's tools are Codex "dynamic tools"
// (an experimental part of the protocol), which Codex calls back over the
// same connection.
//
// Codex has no switch for its built-in shell, so the app-server runs in
// verdict's OS sandbox (src/sandbox.ts) with no network of its own. Its only
// way out is verdict's egress proxy (src/egress.ts), which tunnels HTTPS to
// OpenAI's hosts and refuses everything else, so neither Codex nor its shell
// can reach anywhere else. Codex follows the proxy because its throwaway home
// turns on `respect_system_proxy`; if it ever connects directly instead, the
// sandbox refuses the connection, so this fails closed. The shell can still
// read the repo and the copied login, but can only send them to OpenAI.
//
// With VERDICT_SANDBOX=off, none of this applies: Codex's own read-only
// sandbox is the only limit, and it can't stop reads outside the repo.
import { z } from "zod";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { callTool, type Agent, type AgentTask } from "../agent.ts";
import { startEgress } from "../egress.ts";
import { sandboxed } from "../sandbox.ts";

// Where Codex may connect: the ChatGPT backend it uses with a ChatGPT login,
// the OpenAI API (API-key logins), and token refresh.
const CODEX_HOSTS = (process.env.VERDICT_CODEX_HOSTS ?? "chatgpt.com,api.openai.com,auth.openai.com").split(",").map((h) => h.trim()).filter(Boolean);

interface Launched {
  argv: string[];
  env?: Record<string, string>;
  done: () => Promise<void>;
}

// Codex gets a throwaway CODEX_HOME holding only a copy of the user's login
// (auth.json) and a config that turns on proxy support. It never sees, and
// can't change, the real config.toml (hooks, MCP servers, notify commands that
// would later run unsandboxed), history or sessions. The throwaway home sits
// under ~/.cache/verdict, inside the home directory that every other verdict
// sandbox is denied, so planner-run code can't read the login copy.
async function launch(cwd: string): Promise<Launched> {
  if (process.env.VERDICT_SANDBOX === "off") return { argv: ["codex", "app-server"], done: async () => {} };
  const realHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const bin = Bun.which("codex");
  if (!bin) throw new Error("codex is not installed: install the Codex CLI and run `codex login`");
  const realAuth = join(realHome, "auth.json");
  if (!existsSync(realAuth)) throw new Error(`no Codex login in ${realHome}: run \`codex login\`, then run verdict again`);

  const cache = join(homedir(), ".cache", "verdict");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(cache, "codex-"));
  chmodSync(work, 0o700);
  const codexHome = join(work, "home");
  mkdirSync(codexHome, { mode: 0o700 });
  const before = readFileSync(realAuth, "utf8");
  writeFileSync(join(codexHome, "auth.json"), before, { mode: 0o600 });
  writeFileSync(join(codexHome, "config.toml"), "[features]\nrespect_system_proxy = true\n", { mode: 0o600 });

  let egress: Awaited<ReturnType<typeof startEgress>> | undefined;
  const done = async () => {
    try {
      await egress?.close();
      copyBackLogin(before, join(codexHome, "auth.json"), realAuth);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
  try {
    egress = await startEgress(CODEX_HOSTS, process.platform === "linux" ? join(work, "egress.sock") : undefined);
    const proxy = `http://127.0.0.1:${egress.port}`;
    const env = { CODEX_HOME: codexHome, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" };
    const install = dirname(dirname(realpathSync(bin)));
    const box = { readable: [cwd, install], writable: [codexHome], network: false, localhostPorts: [egress.port], env };
    if (process.platform === "linux") {
      // Inside its own network namespace, Codex reaches the proxy through a
      // forwarder that listens on the same port there.
      const forward = join(import.meta.dir, "netns-forward.ts");
      const wrapped = sandboxed(
        [process.execPath, forward, egress.socketPath!, String(egress.port), "--", "codex", "app-server"],
        { ...box, readable: [...box.readable, dirname(forward), dirname(process.execPath)], writable: [...box.writable, work] },
        cwd,
      );
      return { ...wrapped, done };
    }
    return { ...sandboxed(["codex", "app-server"], box, cwd), done };
  } catch (err) {
    await done();
    throw err;
  }
}

// After the run, a refreshed login is copied back so the user stays logged
// in, but only if it is a regular file (not a link), parses as a Codex login,
// and is still the same account: anything else in the sandbox could have
// written it, and swapping in another account would send the user's later
// Codex sessions there.
export function copyBackLogin(before: string, copyPath: string, realPath: string): void {
  const st = lstatSync(copyPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return;
  const after = readFileSync(copyPath, "utf8");
  if (after === before || !sameAccount(before, after)) return;
  writeFileSync(realPath, after, { mode: 0o600 });
}

export function sameAccount(a: string, b: string): boolean {
  try {
    const x = JSON.parse(a), y = JSON.parse(b);
    if ((x.OPENAI_API_KEY ?? null) !== (y.OPENAI_API_KEY ?? null)) return false;
    const ax = x.tokens?.account_id, ay = y.tokens?.account_id;
    if (typeof ax !== "string" || ax !== ay) return false;
    return jwtSubject(x.tokens?.id_token) !== null && jwtSubject(x.tokens?.id_token) === jwtSubject(y.tokens?.id_token);
  } catch {
    return false;
  }
}

function jwtSubject(token: unknown): string | null {
  if (typeof token !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

class Connection {
  private proc!: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private cleanup: () => Promise<void> = async () => {};
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr = "";

  constructor(
    private cwd: string,
    launched: Launched,
    private onRequest: (m: Message) => Promise<unknown>,
    private onNotification: (m: Message) => void,
  ) {
    const { argv, env, done } = launched;
    this.cleanup = done;
    this.proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.read();
    void (async () => {
      for await (const chunk of this.proc.stderr) this.stderr = (this.stderr + new TextDecoder().decode(chunk)).slice(-4000);
    })();
    void this.proc.exited.then((code) => {
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code}): ${this.stderr.trim().split("\n").at(-1) ?? ""}`));
      this.pending.clear();
    });
  }

  private send(m: object) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private async read() {
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) void this.handle(JSON.parse(line) as Message);
      }
    }
  }

  private async handle(m: Message) {
    if (m.method && m.id !== undefined) {
      try {
        this.send({ id: m.id, result: (await this.onRequest(m)) ?? null });
      } catch (err) {
        this.send({ id: m.id, error: { code: -32601, message: (err as Error).message } });
      }
    } else if (m.method) {
      this.onNotification(m);
    } else if (typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`codex: ${m.error.message ?? `error ${m.error.code}`}`));
      else p.resolve(m.result);
    }
  }

  async close() {
    this.proc.kill();
    await this.proc.exited;
    await this.cleanup();
  }
}

export const codex: Agent = {
  name: "codex",
  async run(task: AgentTask) {
    let steps = 0;
    let done!: () => void;
    let failed!: (e: Error) => void;
    const finished = new Promise<void>((resolve, reject) => ((done = resolve), (failed = reject)));

    const launched = await launch(task.cwd);
    let conn: Connection;
    try {
      conn = new Connection(
      task.cwd,
      launched,
      async (m) => {
        if (m.method === "item/tool/call") {
          const tool = task.tools[m.params.tool];
          if (!tool) return { contentItems: [{ type: "inputText", text: `no tool named ${m.params.tool}` }], success: false };
          if (++steps > task.maxSteps) {
            return { contentItems: [{ type: "inputText", text: "step limit reached: call submit now, or stop" }], success: false };
          }
          const r = await callTool(tool, m.params.arguments);
          return { contentItems: [{ type: "inputText", text: r.text }], success: !r.isError };
        }
        // The read-only sandbox with approvals off should never ask; if it does, refuse.
        if (m.method?.endsWith("/requestApproval")) return { decision: "decline" };
        throw new Error(`verdict does not handle ${m.method}`);
      },
      (m) => {
        if (m.method === "turn/completed") done();
        if (m.method === "error" && m.params?.willRetry === false) failed(new Error(`codex: ${JSON.stringify(m.params.error ?? m.params)}`));
      },
      );
    } catch (err) {
      await launched.done(); // e.g. the spawn failed: still remove the login copy
      throw err;
    }
    try {
      await conn.request("initialize", { clientInfo: { name: "verdict", version: "0.0.0", title: null }, capabilities: { experimentalApi: true } });
      const thread = await conn.request("thread/start", {
        cwd: task.cwd,
        ...(task.model ? { model: task.model } : {}),
        approvalPolicy: "never",
        // Inside verdict's sandbox Codex can't start its own (macOS sandboxes
        // don't nest), and verdict's is the stricter one. Without verdict's,
        // fall back to Codex's read-only mode.
        sandbox: process.env.VERDICT_SANDBOX === "off" ? "read-only" : "danger-full-access",
        developerInstructions: task.system,
        ephemeral: true,
        dynamicTools: Object.entries(task.tools).map(([name, t]) => ({
          type: "function",
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.schema),
        })),
      });
      await conn.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: task.prompt, text_elements: [] }],
        effort: task.reasoning,
      });
      await finished;
    } finally {
      await conn.close();
    }
  },
};
