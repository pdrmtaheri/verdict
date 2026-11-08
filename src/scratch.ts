// A disposable copy of the repo for breaking code without touching it.
// Copies the files git would track (including uncommitted and untracked,
// non-ignored files) and links dependency directories instead of copying them.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exec } from "./exec.ts";

const LINKED = ["node_modules", ".venv", "venv"];

export async function withScratch<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "verdict-scratch-"));
  try {
    const listed = await exec(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
    const files =
      listed.code === 0
        ? listed.output.split("\n").filter(Boolean)
        : await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, dot: true }));
    for (const f of files) {
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

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
