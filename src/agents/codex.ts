// Codex through `codex app-server`: newline-delimited JSON-RPC 2.0 on stdio,
// on the local `codex` login. verdict's tools are Codex "dynamic tools"
// (an experimental part of the protocol), which Codex calls back over the
// same connection.
//
// Codex has no switch for its built-in shell, so three things confine it:
// 1. Approvals: threads run with approval policy "untrusted", so Codex runs
//    only commands on its built-in list of safe read-only ones (ls, cat, rg…)
//    without asking, and asks before anything else. verdict declines every
//    request, so curl, python, scripts and the like never run.
// 2. Sandbox: the app-server runs in verdict's OS sandbox (src/sandbox.ts),
//    which on macOS denies reads everywhere but the system, installed tools,
//    the repo and Codex's own install and home, with no network of its own; its only way out is verdict's egress proxy
//    (src/egress.ts), which tunnels HTTPS to OpenAI's hosts. Codex follows the
//    proxy because its throwaway home turns on `respect_system_proxy`; if it
//    connects directly the sandbox refuses, so this fails closed.
// 3. A throwaway CODEX_HOME holding only a copy of the login.
// Remaining risk: a safe-listed read command can put the repo or the login
// copy into the model's context. From there it can leave only through Codex's
// own requests to OpenAI (which carry that login anyway) or verdict's tools
// (files in .verdict/, which a person reviews before merging).
//
// Without verdict's sandbox none of this holds, and Codex's own read-only
// sandbox can't stop reads outside the repo, so with VERDICT_SANDBOX=off
// verdict refuses to start Codex.
import { z } from "zod";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { callTool, type Agent, type AgentTask } from "../agent.ts";
import { errorMessage } from "../fsx.ts";
import { startEgress } from "./egress.ts";
import { sandboxed } from "../sandbox.ts";
import { bunCommand } from "../runtime.ts";
// @ts-expect-error: with type "text", the import is the file's source, not its module
// oxlint-disable-next-line import/default -- a text import has no module exports
import forwarderSource from "./netns-forward.ts" with { type: "text" };

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the import above
const FORWARDER = forwarderSource as string;

// Where Codex may connect: the ChatGPT backend it uses with a ChatGPT login,
// the OpenAI API (API-key logins), and token refresh.
const CODEX_HOSTS = (process.env.VERDICT_CODEX_HOSTS ?? "chatgpt.com,api.openai.com,auth.openai.com").split(",").map((h) => h.trim()).filter(Boolean);

export interface Launched {
  argv: string[];
  env?: Record<string, string>;
  done: () => Promise<void>;
}

// Tests of the protocol swap in a launcher that runs a fake app-server
// directly; the sandbox has its own tests.
export const testing: { launch?: (cwd: string) => Promise<Launched> } = {};

// Codex gets a throwaway CODEX_HOME holding only a copy of the user's login
// (auth.json) and a config that turns on proxy support. It never sees, and
// can't change, the real config.toml (hooks, MCP servers, notify commands that
// would later run unsandboxed), history or sessions. The throwaway home sits
// under ~/.cache/verdict, inside the home directory that every other verdict
// sandbox is denied, so planner-run code can't read the login copy.
//
// Nothing is copied back: a login written inside the sandbox can't be
// trusted (a prompt-injected command could swap in another account's refresh
// token). If Codex refreshed its tokens there, the user may need to run
// `codex login` again; verdict says so.
async function launch(cwd: string): Promise<Launched> {
  const bin = Bun.which("codex", { PATH: process.env.PATH ?? "" });
  if (process.env.VERDICT_SANDBOX === "off") {
    throw new Error(
      "Codex's built-in shell can read files outside the repo unless verdict's sandbox confines it, and VERDICT_SANDBOX=off turns that off: " +
        "run verdict without VERDICT_SANDBOX=off, or set VERDICT_AGENT=claude-code or pi",
    );
  }
  const realHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
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
      if (loginChanged(before, join(codexHome, "auth.json"))) {
        console.error("verdict: Codex refreshed its login inside verdict's sandbox. verdict doesn't copy it back; if codex asks you to log in, run `codex login`.");
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
  try {
    egress = await startEgress(CODEX_HOSTS, process.platform === "linux" ? join(work, "egress.sock") : undefined);
    const proxy = `http://127.0.0.1:${egress.port}`;
    const env = { CODEX_HOME: codexHome, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" };
    const install = dirname(dirname(realpathSync(bin)));
    const box = { readable: [cwd, install], writable: [codexHome], network: false, localhostPorts: [egress.port], env, readsListedOnly: true };
    if (process.platform === "linux") {
      // Inside its own network namespace, Codex reaches the proxy through a
      // forwarder that listens on the same port there.
      // The forwarder's source is embedded (it imports only node:net), so it
      // runs the same from a checkout and from a compiled verdict.
      const forward = join(work, "netns-forward.ts");
      writeFileSync(forward, FORWARDER, { mode: 0o600 });
      const bun = bunCommand(null);
      const wrapped = sandboxed(
        [bun.bin, forward, egress.socketPath!, String(egress.port), "--", bin, "app-server"],
        { ...box, env: { ...box.env, ...bun.env }, readable: [...box.readable, ...bun.readable], writable: [...box.writable, work] },
        cwd,
      );
      return { ...wrapped, done };
    }
    return { ...sandboxed([bin, "app-server"], box, cwd), done };
  } catch (err) {
    await done();
    throw err;
  }
}

function loginChanged(before: string, copyPath: string): boolean {
  try {
    return readFileSync(copyPath, "utf8") !== before;
  } catch {
    return false;
  }
}

interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

// The parts of Codex's messages verdict reads.
const ToolCall = z.object({ tool: z.string(), arguments: z.unknown() });
const ErrorNotice = z.object({ willRetry: z.boolean().optional(), error: z.unknown().optional() });
const ThreadStarted = z.object({ thread: z.object({ id: z.string() }) });

class Connection {
  private proc!: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private cleanup: () => Promise<void> = async () => {};
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
    void (async () => {
      const code = await this.proc.exited;
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code}): ${this.stderr.trim().split("\n").at(-1) ?? ""}. Check that \`codex\` runs and is logged in (run \`codex login\`), then run verdict again`));
      this.pending.clear();
    })();
  }

  private send(m: object) {
    void this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private async read() {
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        // The app-server's own output: trusted to be JSON-RPC, as Codex documents it.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        if (line) void this.handle(JSON.parse(line) as Message);
      }
    }
  }

  private async handle(m: Message) {
    if (m.method && m.id !== undefined) {
      try {
        this.send({ id: m.id, result: (await this.onRequest(m)) ?? null });
      } catch (err) {
        this.send({ id: m.id, error: { code: -32601, message: errorMessage(err) } });
      }
    } else if (m.method) {
      this.onNotification(m);
    } else if (typeof m.id === "number" && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      if (m.error) p.reject(new Error(`codex: ${m.error.message ?? `error ${m.error.code}`}. Update the Codex CLI if verdict's request isn't supported, or set VERDICT_AGENT=claude-code or pi`));
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
    const { promise: finished, resolve: done, reject: failed } = Promise.withResolvers<void>();

    const launched = await (testing.launch ?? launch)(task.cwd);
    let conn: Connection;
    try {
      conn = new Connection(
      task.cwd,
      launched,
      async (m) => {
        if (m.method === "item/tool/call") {
          const call = ToolCall.parse(m.params);
          const tool = task.tools[call.tool];
          if (!tool) return { contentItems: [{ type: "inputText", text: `no tool named ${call.tool}` }], success: false };
          if (++steps > task.maxSteps) {
            return { contentItems: [{ type: "inputText", text: "step limit reached: call submit now, or stop" }], success: false };
          }
          const r = await callTool(tool, call.arguments);
          return { contentItems: [{ type: "inputText", text: r.text }], success: !r.isError };
        }
        // Anything off Codex's safe read-only list asks first; verdict refuses it all.
        if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") return { decision: "decline" };
        if (m.method?.endsWith("/requestApproval")) throw new Error("declined by verdict");
        throw new Error(`verdict does not handle ${m.method}`);
      },
      (m) => {
        if (m.method === "turn/completed") done();
        if (m.method !== "error") return;
        const notice = ErrorNotice.safeParse(m.params);
        if (notice.success && notice.data.willRetry === false) failed(new Error(`codex stopped: ${JSON.stringify(notice.data.error ?? m.params)}. Run verdict again; if it keeps failing, check \`codex\` on its own or set VERDICT_AGENT=claude-code or pi`));
      },
      );
    } catch (err) {
      await launched.done(); // e.g. the spawn failed: still remove the login copy
      throw err;
    }
    try {
      await conn.request("initialize", { clientInfo: { name: "verdict", version: "0.0.0", title: null }, capabilities: { experimentalApi: true } });
      const thread = ThreadStarted.parse(await conn.request("thread/start", {
        cwd: task.cwd,
        ...(task.model ? { model: task.model } : {}),
        // "untrusted": only Codex's safe read-only commands run without asking.
        approvalPolicy: "untrusted",
        // Inside verdict's sandbox Codex can't start its own (macOS sandboxes
        // don't nest), and verdict's is the stricter one.
        sandbox: "danger-full-access",
        developerInstructions: task.system,
        ephemeral: true,
        dynamicTools: Object.entries(task.tools).map(([name, t]) => ({
          type: "function",
          name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.schema),
        })),
      }));
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
