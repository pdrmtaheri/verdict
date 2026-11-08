// Pi through its own SDK (@earendil-works/pi-coding-agent), on the user's Pi
// credentials and model settings. verdict's tools are Pi custom tools; Pi's
// built-in tools, extensions, skills, prompt templates and context files are
// off, and the session lives in memory only.
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { callTool, type Agent } from "../agent.ts";

export const pi: Agent = {
  name: "pi",
  async run(task) {
    let steps = 0;
    const customTools: ToolDefinition[] = Object.entries(task.tools).map(([name, t]) => ({
      name,
      label: name,
      description: t.description,
      parameters: Type.Unsafe(z.toJSONSchema(t.schema)),
      async execute(_id: string, params: unknown) {
        if (++steps > task.maxSteps) throw new Error("step limit reached: call submit now, or stop");
        const r = await callTool(t, params);
        if (r.isError) throw new Error(r.text);
        return { content: [{ type: "text" as const, text: r.text }], details: undefined };
      },
    }));

    const resourceLoader = new DefaultResourceLoader({
      cwd: task.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => task.system,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    // VERDICT_MODEL is "<provider>/<model>" for Pi; otherwise Pi's default model.
    const modelRuntime = await ModelRuntime.create();
    let model;
    if (task.model) {
      const [provider, ...rest] = task.model.split("/");
      model = modelRuntime.getModel(provider!, rest.join("/"));
      if (!model) throw new Error(`Pi has no model ${task.model}; list them with \`pi --list-models\``);
    }

    const { session } = await createAgentSession({
      cwd: task.cwd,
      sessionManager: SessionManager.inMemory(task.cwd),
      resourceLoader,
      modelRuntime,
      ...(model ? { model } : {}),
      thinkingLevel: task.reasoning,
      noTools: "all",
      tools: Object.keys(task.tools), // only verdict's tools
      customTools,
    });
    try {
      await session.prompt(task.prompt);
    } finally {
      session.dispose();
    }
  },
};
