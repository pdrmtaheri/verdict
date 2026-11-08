import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

export function repo(files: Record<string, string>, executable: string[] = []): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const path of executable) chmodSync(join(root, path), 0o755);
  return root;
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// A model that makes the given tool calls, one per step, in order.
export function scriptedModel(calls: { tool: string; input: unknown }[]): LanguageModel & { prompts: unknown[] } {
  let step = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const call = calls[step++];
      if (!call) {
        return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: `call-${step}`, toolName: call.tool, input: JSON.stringify(call.input) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return Object.assign(model, { prompts });
}
