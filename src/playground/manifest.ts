// PLAYGROUND.json: what makes a verdict repo a playground. Everything else
// (laws, lock, enforcers, the agent's code) is the normal verdict layout.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { errorMessage } from "../fsx.ts";
import { parseLaws } from "../laws.ts";
import { hasVersion } from "./versions.ts";

export const PANELS = ["brief", "preview", "laws", "checks", "files", "activity"] as const;

export const Manifest = z.object({
  title: z.string().min(1),
  idea: z.string().min(1).describe("One line: what is being built"),
  brief: z.string().min(1).describe("Instructions for the connected agent"),
  panels: z.array(z.enum(PANELS)).min(1).default([...PANELS]),
  // Top-level directories the agent may write to with write_file.
  writable: z.array(z.string().min(1)).default(["src", "public", "test", "tests", ".verdict"]),
  // How the playground's own code is shown as a version, and the others
  // (code in versions/<id>/). Optional: a folder in versions/ is enough.
  main: z.object({ label: z.string(), note: z.string().optional() }).optional(),
  versions: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"), label: z.string().optional(), note: z.string().optional() })).optional(),
  // An introduction the page plays on first open, as a script: each chapter
  // shows a law, the lines planning it adds to VERDICT.lock, and the checks
  // running on every version, striking out the versions that fail. Nothing
  // runs: the page only plays it.
  story: z
    .object({
      intro: z.string().min(1),
      versions: z.array(z.string().min(1)).min(2).optional().describe("The versions the story shows, main first. Default every version"),
      chapters: z
        .array(
          z.object({
            title: z.string().min(1),
            method: z.string().min(1).describe('The way of checking this chapter introduces, such as "a model check"'),
            text: z.string().min(1).describe("What goes wrong in the version this law catches"),
            law: z.string().min(1).describe("The law, as written in VERDICT.md"),
            lock: z.string().min(1).describe("The lines planning the law adds to VERDICT.lock"),
            checks: z.array(z.object({ kind: z.string().min(1), path: z.string().min(1) })).min(1).describe("The enforcers planning adds, as in the lock entry"),
            fails: z.array(z.string().min(1)).min(1).describe("The versions this law catches"),
            caughtBy: z.string().optional().describe("The path of the check that catches them, when the law has several"),
          }),
        )
        .min(1),
      outro: z.string().min(1),
    })
    .optional(),
});
export type Manifest = z.infer<typeof Manifest>;

export const MANIFEST_FILE = "PLAYGROUND.json";

const oneLine = (t: string) => t.replaceAll(/\s+/g, " ").trim();

export function loadManifest(root: string): Manifest {
  const file = join(root, MANIFEST_FILE);
  if (!existsSync(file)) throw new Error(`no ${MANIFEST_FILE} in ${root}: create one (see skills/create-playground) or run \`verdict playground validate\``);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} is not valid JSON: ${errorMessage(err)}`, { cause: err });
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) throw new Error(`${MANIFEST_FILE} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// Every problem with a playground directory, each saying what to do next.
export function validatePlayground(root: string): string[] {
  const problems: string[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return [`${root} is not a directory`];
  let manifest: Manifest | null = null;
  try {
    manifest = loadManifest(root);
  } catch (err) {
    problems.push(errorMessage(err));
  }
  const lawsFile = join(root, "VERDICT.md");
  if (!existsSync(lawsFile)) problems.push("no VERDICT.md: add at least one law as a top-level bullet");
  else if (parseLaws(readFileSync(lawsFile, "utf8")).length === 0) problems.push("VERDICT.md has no laws: add a top-level bullet per law");
  // The story is a script, but the laws and versions it names must still exist.
  const laws = new Set(existsSync(lawsFile) ? parseLaws(readFileSync(lawsFile, "utf8")).map((l) => oneLine(l.text)) : []);
  for (const [i, c] of (manifest?.story?.chapters ?? []).entries()) {
    if (!laws.has(oneLine(c.law))) problems.push(`story chapter ${i + 1}'s law is not a law in VERDICT.md: copy it from there word for word`);
    for (const v of c.fails) if (!hasVersion(root, manifest!, v)) problems.push(`story chapter ${i + 1} fails version "${v}", which does not exist: add versions/${v}/ or fix the id`);
    if (c.caughtBy && !c.checks.some((k) => k.path === c.caughtBy)) problems.push(`story chapter ${i + 1} is caught by ${c.caughtBy}, which is not one of its checks: use one of their paths`);
  }
  for (const v of manifest?.story?.versions ?? []) if (!hasVersion(root, manifest!, v)) problems.push(`the story shows version "${v}", which does not exist: add versions/${v}/ or fix the id`);
  for (const dir of manifest?.writable ?? []) {
    const n = normalize(dir);
    if (isAbsolute(n) || n.startsWith("..") || n.includes("/") || n === "." || ["VERDICT.md", "VERDICT.lock", MANIFEST_FILE].includes(n)) {
      problems.push(`writable entry "${dir}" must be a top-level directory name inside the playground`);
    }
  }
  return problems;
}
