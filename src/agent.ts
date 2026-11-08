// A tool loop that ends when the model calls its `submit` tool.
import { generateText, hasToolCall, isStepCount, tool, type LanguageModel, type ToolSet } from "ai";
import type { z } from "zod";

export interface AgentOptions<S extends z.ZodType> {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools: ToolSet;
  submit: { description: string; schema: S };
  maxSteps?: number;
  reasoning?: "low" | "medium" | "high";
}

export async function runAgent<S extends z.ZodType>(opts: AgentOptions<S>): Promise<z.infer<S> | null> {
  let submitted: z.infer<S> | null = null;
  const submit = tool({
    description: opts.submit.description,
    inputSchema: opts.submit.schema,
    execute: async (input: z.infer<S>) => {
      submitted = input;
      return "received";
    },
  });
  await generateText({
    model: opts.model,
    system: opts.system,
    prompt: opts.prompt,
    tools: { ...opts.tools, submit },
    stopWhen: [hasToolCall("submit"), isStepCount(opts.maxSteps ?? 40)],
    reasoning: opts.reasoning ?? "medium",
  });
  return submitted;
}
