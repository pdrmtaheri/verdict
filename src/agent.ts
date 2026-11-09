// verdict runs its agents (the planner, the LLM judge) on a coding agent the
// user already has and is logged into: Claude Code, Codex or Pi. Each one runs
// its own tool loop; verdict hands it verdict's tools and reads back the
// `submit` call. The agents' own built-in tools are switched off, so the same
// confinement applies whichever agent runs.
import { z } from "zod";
import { errorMessage } from "./fsx.ts";

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  description: string;
  schema: S;
  // A method, so a Tool of any schema is a Tool: callTool parses its input
  // against `schema` before calling it.
  execute(input: z.infer<S>): Promise<string>;
}
export type Tools = Record<string, Tool>;

// Infers the input type of `execute` from the schema.
export const defineTool = <S extends z.ZodObject>(t: Tool<S>): Tool<S> => t;

// Validates the agent's input against the schema, then runs the tool. Errors
// come back as text for the agent to read, never as exceptions.
export async function callTool(tool: Tool, input: unknown): Promise<{ text: string; isError: boolean }> {
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { text: `invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
  try {
    return { text: await tool.execute(parsed.data), isError: false };
  } catch (err) {
    return { text: errorMessage(err), isError: true };
  }
}

export const REASONING = ["low", "medium", "high"] as const;
export type Reasoning = (typeof REASONING)[number];

// VERDICT_REASONING, when it's set.
function reasoningFromEnv(): Reasoning | undefined {
  const value = process.env.VERDICT_REASONING;
  if (value === undefined || value === "") return undefined;
  const known = REASONING.find((r) => r === value);
  if (!known) throw new Error(`VERDICT_REASONING=${value} isn't a reasoning level: set it to one of ${REASONING.join(", ")}, or unset it`);
  return known;
}

export interface AgentTask {
  system: string;
  prompt: string;
  tools: Tools;
  cwd: string;
  maxSteps: number;
  reasoning: Reasoning;
  model?: string; // the agent's own model name; its default when unset
}

export interface Agent {
  name: string;
  run(task: AgentTask): Promise<void>;
}

// Tests swap in a scripted agent here.
export const overrides: { agent?: Agent } = {};

export const AGENTS = ["claude-code", "codex", "pi"] as const;

async function pickAgent(): Promise<Agent> {
  if (overrides.agent) return overrides.agent;
  const name = process.env.VERDICT_AGENT ?? "claude-code";
  switch (name) {
    case "claude-code":
      return (await import("./agents/claude-code.ts")).claudeCode;
    case "codex":
      return (await import("./agents/codex.ts")).codex;
    case "pi":
      return (await import("./agents/pi.ts")).pi;
    default:
      throw new Error(`VERDICT_AGENT=${name} isn't an agent verdict knows: set it to one of ${AGENTS.join(", ")}, or unset it to use claude-code`);
  }
}

export interface AgentOptions<S extends z.ZodObject> {
  system: string;
  prompt: string;
  tools: Tools;
  cwd: string;
  // Returning a string rejects the submission; the agent sees it and can retry.
  submit: { description: string; schema: S; validate?: (input: z.infer<S>) => Promise<string | null> };
  maxSteps?: number;
  reasoning?: Reasoning;
}

// Runs a task until the agent's `submit` call is accepted or the agent stops.
export async function runAgent<S extends z.ZodObject>(opts: AgentOptions<S>): Promise<z.infer<S> | null> {
  let submitted: z.infer<S> | null = null;
  // Agents may call tools in parallel. Submissions are handled one at a time,
  // and once one is accepted every later one is refused without being
  // validated, so the first accepted plan is the one runAgent returns.
  let queue: Promise<unknown> = Promise.resolve();
  const submit = defineTool({
    description: opts.submit.description,
    schema: opts.submit.schema,
    execute: (input) => {
      const handled = queue.then(async () => {
        if (submitted) return "already accepted. You are done; stop here.";
        const problem = (await opts.submit.validate?.(input)) ?? null;
        if (problem) return `rejected: ${problem}\nFix it and call submit again.`;
        submitted = input;
        return "accepted. You are done; stop here.";
      });
      queue = handled.catch(() => {});
      return handled;
    },
  });
  const agent = await pickAgent();
  let failure: Error | null = null;
  try {
    await agent.run({
      system: `${opts.system}\n\nUse only the tools provided. Finish by calling submit; once it is accepted, stop.`,
      prompt: opts.prompt,
      tools: { ...opts.tools, submit },
      cwd: opts.cwd,
      maxSteps: opts.maxSteps ?? 40,
      reasoning: reasoningFromEnv() ?? opts.reasoning ?? "medium",
      model: process.env.VERDICT_MODEL,
    });
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  }
  // An agent that doesn't wait for its own tool calls can finish while a
  // submit is still being validated: let it settle first.
  for (let settled = queue; ; settled = queue) {
    await settled;
    if (settled === queue) break;
  }
  // Once a plan is accepted it stands, whatever the agent does afterwards
  // (an adapter throws on a non-success result, a protocol error, the step limit).
  if (submitted) return submitted;
  if (failure) throw failure;
  return null;
}
