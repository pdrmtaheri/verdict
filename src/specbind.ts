// Ties a TLA+ spec to the code it describes. A spec only checks a design, and
// no edit to the code can make TLC fail, so on its own it can never be seen to
// fail on a break. The spec instead names the files it models, with a comment
// line per file:  \* models: public/controller.js 3fa9c1d2e4b5
// verdict stamps that hash, and a spec whose files changed fails (stale), the
// way an edited law is unplanned until `verdict plan`. A paired test replays
// the spec against the code; that test is what says whether the code still
// conforms, and `plan` re-stamps a stale spec when the test still passes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STALE = "the code this spec models changed";

const LINE = /(\bmodels:\s*)(\S+)(?:[ \t]+([0-9a-f]{12}))?/;

export interface Model {
  file: string;
  hash: string | null; // null: not stamped yet
}

export function modelsOf(text: string): Model[] {
  const out: Model[] = [];
  for (const line of text.split("\n").slice(0, 40)) {
    const m = LINE.exec(line);
    if (m) out.push({ file: m[2]!, hash: m[3] ?? null });
  }
  return out;
}

export function hashFile(root: string, file: string): string | null {
  const abs = join(root, file);
  if (!existsSync(abs)) return null;
  return new Bun.CryptoHasher("sha256").update(readFileSync(abs)).digest("hex").slice(0, 12);
}

// Why this spec no longer matches its code, or null when it does.
// The spec is read from `root`; the files it models are looked up in `target`.
export function staleReason(root: string, specPath: string, target = root): string | null {
  const models = modelsOf(readFileSync(join(root, specPath), "utf8"));
  if (models.length === 0) return `${specPath} has no "models:" line: name each file the spec describes, e.g. \\* models: src/controller.js`;
  for (const m of models) {
    const now = hashFile(target, m.file);
    if (now === null) return `${STALE}: ${m.file} no longer exists. Run \`verdict plan\` so the spec is re-read against the code`;
    if (m.hash === null) return `${specPath} is not stamped with the hash of ${m.file}. Run \`verdict plan\``;
    if (now !== m.hash) return `${STALE}: ${m.file} (was ${m.hash}, now ${now}). Run \`verdict plan\`: it re-stamps the spec if its tests still pass, and re-plans the law if not`;
  }
  return null;
}

// Writes the current hash of every modeled file into the spec.
export function stampModels(root: string, specPath: string): void {
  const abs = join(root, specPath);
  const lines = readFileSync(abs, "utf8").split("\n");
  let seen = 0;
  const stamped = lines.map((line, i) => {
    if (i >= 40) return line;
    const m = LINE.exec(line);
    if (!m) return line;
    seen++;
    const hash = hashFile(root, m[2]!);
    return hash ? line.replace(LINE, `$1$2 ${hash}`) : line;
  });
  if (seen > 0) writeFileSync(abs, stamped.join("\n"));
}

export const isStale = (message: string) => message.startsWith(STALE);
