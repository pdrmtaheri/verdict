// Claude Code through Anthropic's Claude Agent SDK, on the local `claude` login.
// verdict's tools are an in-process MCP server; Claude Code's built-in tools
// (Bash, Read, Edit…) and the user's own MCP servers are switched off.
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { callTool, type Agent } from "../agent.ts";
import { COMPILED } from "../runtime.ts";

const SERVER = "verdict";

// From source, the SDK runs the Claude Code binary from its own platform
// package. A compiled verdict can't reach node_modules, so it runs the
// `claude` the user installed (or VERDICT_CLAUDE).
function claudeExecutable(): string | undefined {
  const given = process.env.VERDICT_CLAUDE;
  if (given) return given;
  if (!COMPILED) return undefined;
  const found = Bun.which("claude");
  if (!found) throw new Error("Claude Code is not installed: install it (https://claude.com/claude-code) and log in by running `claude` once, set VERDICT_CLAUDE to its path, or set VERDICT_AGENT=codex or pi");
  return found;
}

export const claudeCode: Agent = {
  name: "claude-code",
  async run(task) {
    const tools = Object.entries(task.tools).map(([name, t]) =>
      tool(name, t.description, t.schema.shape, async (input) => {
        const r = await callTool(t, input);
        return { content: [{ type: "text", text: r.text }], isError: r.isError };
      }),
    );
    const pathToClaudeCodeExecutable = claudeExecutable();
    const session = query({
      prompt: task.prompt,
      options: {
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        systemPrompt: task.system,
        model: task.model ?? "sonnet",
        effort: task.reasoning,
        cwd: task.cwd,
        mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, tools }) },
        tools: [], // no built-in tools: only verdict's
        allowedTools: Object.keys(task.tools).map((name) => `mcp__${SERVER}__${name}`),
        strictMcpConfig: true, // none of the user's MCP servers or claude.ai connectors
        settingSources: [], // ignore the user's and the repo's Claude settings, hooks and skills
        maxTurns: task.maxSteps,
        persistSession: false,
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      },
    });
    for await (const message of session) {
      if (message.type === "result" && message.subtype !== "success" && message.subtype !== "error_max_turns") {
        const why = "errors" in message ? `: ${(message.errors ?? []).join("; ")}` : "";
        throw new Error(`Claude Code stopped (${message.subtype}${why}). Check that \`claude\` works and is logged in (run \`claude\` once), then run verdict again`);
      }
    }
  },
};
