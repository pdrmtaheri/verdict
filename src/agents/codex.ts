// Codex through `codex app-server`: newline-delimited JSON-RPC 2.0 on stdio,
// on the local `codex` login. verdict's tools are Codex "dynamic tools"
// (an experimental part of the protocol), which Codex calls back over the
// same connection.
//
// Codex has no switch for its built-in shell, so the app-server itself runs
// in verdict's OS sandbox (src/sandbox.ts): its shell can read the repo and
// Codex's own files but nothing else in the user's home, and can write only to
// Codex's state directory. It keeps network access, since Codex needs it to
// reach its model. With VERDICT_SANDBOX=off, Codex's own read-only sandbox is
// the only limit, and it can't stop reads outside the repo.
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { callTool, type Agent, type AgentTask } from "../agent.ts";
import { sandboxed } from "../sandbox.ts";

function launch(cwd: string): { argv: string[]; env?: Record<string, string> } {
  if (process.env.VERDICT_SANDBOX === "off") return { argv: ["codex", "app-server"] };
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const bin = Bun.which("codex");
  if (!bin) throw new Error("codex is not installed: install the Codex CLI and run `codex login`");
  const install = dirname(dirname(realpathSync(bin)));
  return sandboxed(["codex", "app-server"], {
    readable: [cwd, install],
    writable: [codexHome].filter(existsSync),
    network: true,
    home: homedir(), // Codex finds its login and config under ~/.codex
    env: { ...(process.env.CODEX_HOME ? { CODEX_HOME: codexHome } : {}) },
  }, cwd);
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };

class Connection {
  private proc!: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stderr = "";

  constructor(
    private cwd: string,
    private onRequest: (m: Message) => Promise<unknown>,
    private onNotification: (m: Message) => void,
  ) {
    const { argv, env } = launch(cwd);
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

  close() {
    this.proc.kill();
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
      conn.close();
    }
  },
};
