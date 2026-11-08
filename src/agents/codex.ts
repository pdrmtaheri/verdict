// Codex through `codex app-server`: newline-delimited JSON-RPC 2.0 on stdio,
// on the local `codex` login. verdict's tools are Codex "dynamic tools"
// (an experimental part of the protocol), which Codex calls back over the
// same connection.
//
// Codex has no switch for its built-in shell, so the app-server itself runs
// in verdict's OS sandbox (src/sandbox.ts): its shell can read the repo and
// Codex's own files but nothing else in the user's home, and can write only to
// Codex's state directory. It keeps network access, since Codex needs it to
// reach its model, and that is the remaining risk: the shell can read the
// copied login and has the network, so a prompt-injected shell command could
// send the login away. Claude Code and Pi have no shell to do that. With
// VERDICT_SANDBOX=off, Codex's own read-only sandbox is the only limit, and it
// can't stop reads outside the repo.
import { z } from "zod";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTool, type Agent, type AgentTask } from "../agent.ts";
import { sandboxed } from "../sandbox.ts";

// Codex inside verdict's sandbox gets a throwaway CODEX_HOME holding only a
// copy of the user's login (auth.json): it never sees, and can't change, the
// real config.toml (hooks, MCP servers, notify commands that would later run
// unsandboxed), history or sessions. If Codex refreshes its tokens, the new
// auth.json is copied back after the run, but only if it is still a login file.
function launch(cwd: string): { argv: string[]; env?: Record<string, string>; done: () => void } {
  if (process.env.VERDICT_SANDBOX === "off") return { argv: ["codex", "app-server"], done: () => {} };
  const realHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const bin = Bun.which("codex");
  if (!bin) throw new Error("codex is not installed: install the Codex CLI and run `codex login`");
  const realAuth = join(realHome, "auth.json");
  if (!existsSync(realAuth)) throw new Error(`no Codex login in ${realHome}: run \`codex login\`, then run verdict again`);
  const codexHome = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-codex-home-"));
  const before = readFileSync(realAuth, "utf8");
  writeFileSync(join(codexHome, "auth.json"), before, { mode: 0o600 });
  const install = dirname(dirname(realpathSync(bin)));
  const box = sandboxed(["codex", "app-server"], {
    readable: [cwd, install],
    writable: [codexHome],
    network: true,
  }, cwd);
  const done = () => {
    try {
      const after = readFileSync(join(codexHome, "auth.json"), "utf8");
      if (after !== before && sameShape(before, after)) writeFileSync(realAuth, after, { mode: 0o600 });
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  };
  return { argv: box.argv, env: { ...box.env, CODEX_HOME: codexHome }, done };
}

// A refreshed login has the same top-level fields as the old one.
function sameShape(a: string, b: string): boolean {
  try {
    const x = JSON.parse(a), y = JSON.parse(b);
    const keys = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : null);
    return keys(x) !== null && keys(x) === keys(y);
  } catch {
    return false;
  }
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

class Connection {
  private proc!: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private cleanup: () => void = () => {};
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr = "";

  constructor(
    private cwd: string,
    private onRequest: (m: Message) => Promise<unknown>,
    private onNotification: (m: Message) => void,
  ) {
    const { argv, env, done } = launch(cwd);
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
    this.cleanup();
  }
}

export const codex: Agent = {
  name: "codex",
  async run(task: AgentTask) {
    let steps = 0;
    let done!: () => void;
    let failed!: (e: Error) => void;
    const finished = new Promise<void>((resolve, reject) => ((done = resolve), (failed = reject)));

    const conn = new Connection(
      task.cwd,
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
