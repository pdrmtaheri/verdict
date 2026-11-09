// A disposable copy of the repo for breaking code without touching it.
// Copies the files git would track (including uncommitted and untracked,
// non-ignored files) and links dependency directories instead of copying them.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isLink, listFiles } from "./fsx.ts";

const LINKED = ["node_modules", ".venv", "venv"];

export async function withScratch<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-scratch-"));
  try {
    for (const f of await listFiles(root, { glob: "**/*", dot: true })) {
      const from = join(root, f);
      if (!existsSync(from) && !isLink(from)) continue; // deleted in the working tree
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      if (isLink(from)) symlinkSync(readlinkSync(from), join(dir, f));
      else copyFileSync(from, join(dir, f));
    }
    for (const d of LINKED) if (existsSync(join(root, d)) && !existsSync(join(dir, d))) symlinkSync(join(root, d), join(dir, d));
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
