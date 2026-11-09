// `verdict init`: draft a VERDICT.md from the rules a project already wrote
// down in prose for people and agents (AGENTS.md, CLAUDE.md, CONTRIBUTING.md,
// .cursor/rules…). It's a draft for a person to edit: verdict doesn't treat
// those files as laws, because they change freely and mix rules with advice.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { lexists } from "./fsx.ts";
import SYSTEM from "./prompts/init.md" with { type: "text" };
import { readTools } from "./tools.ts";
import type { Where } from "./where.ts";

const FILES = [
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", "CONTRIBUTING.md", "CONVENTIONS.md", "STYLEGUIDE.md",
  ".github/copilot-instructions.md", ".github/CONTRIBUTING.md", ".cursorrules", ".windsurfrules", ".clinerules",
];
const DIRS = [".cursor/rules", ".claude/rules", ".github/instructions"];

// The prose rule files in a directory, relative to it.
export function ruleFiles(dir: string): string[] {
  const found = FILES.filter((f) => existsSync(join(dir, f)));
  for (const d of DIRS) {
    if (!existsSync(join(dir, d))) continue;
    for (const f of readdirSync(join(dir, d), { recursive: true }) as string[]) {
      if (/\.(md|mdc|txt)$/.test(f)) found.push(join(d, f));
    }
  }
  return found;
}

const Draft = z.object({
  laws: z.array(z.object({ text: z.string(), from: z.string().describe("The file it came from") })),
  skipped: z.array(z.string()).describe("Rules you left out because they aren't checkable, in a few words each"),
});

export async function init(w: Where, log: (line: string) => void): Promise<number> {
  const target = join(w.dir, "VERDICT.md");
  if (lexists(target)) { // lstat: a dangling symlink counts too
    log(`${relative(w.repo, target) || "VERDICT.md"} already exists: edit it by hand, or move it aside and run \`verdict init\` again`);
    return 2;
  }
  const files = ruleFiles(w.dir);
  if (files.length === 0) {
    log(`found no rules to start from (${[...FILES, ...DIRS].slice(0, 4).join(", ")}…): write VERDICT.md by hand, one law per bullet`);
    return 2;
  }
  log(`drafting laws from ${files.join(", ")}`);
  const draft = await runAgent({
    system: SYSTEM,
    prompt: `Rule files:\n${files.map((f) => `- ${f}`).join("\n")}`,
    tools: readTools(w.dir, w.repo),
    cwd: w.dir,
    submit: { description: "Submit the drafted laws.", schema: Draft },
    maxSteps: 60,
  });
  if (!draft) {
    log("the agent stopped without a draft: run `verdict init` again (a stronger VERDICT_MODEL may help)");
    return 1;
  }
  if (draft.laws.length === 0) {
    log(`nothing in ${files.join(", ")} is checkable as a law: write VERDICT.md by hand, one law per bullet`);
    return 1;
  }
  const md = [
    "# Laws",
    "",
    `<!-- Drafted by \`verdict init\` from ${files.join(", ")}. Edit freely: keep, reword or delete laws,`,
    "     then run `verdict plan`. Each top-level bullet is one law. -->",
    "",
    // The source goes on the line before: an indented line would join the law's text.
    ...draft.laws.map((l) => `<!-- from ${l.from} -->\n- ${l.text.replaceAll(/\s+/g, " ").trim()}\n`),
    "",
  ].join("\n");
  // "wx": create only. If anything appeared at the path meanwhile (a file or
  // a symlink to anywhere), refuse rather than write through it.
  try {
    writeFileSync(target, md, { flag: "wx" });
  } catch {
    log(`${relative(w.repo, target) || "VERDICT.md"} appeared while drafting: move it aside and run \`verdict init\` again`);
    return 2;
  }
  log(`wrote ${relative(w.repo, target) || "VERDICT.md"} with ${draft.laws.length} law${draft.laws.length === 1 ? "" : "s"}: review and edit it, then run \`verdict plan\``);
  for (const s of draft.skipped) log(`  left out: ${s}`);
  return 0;
}
