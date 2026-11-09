// Whether verdict runs from source (`bun src/cli.ts`) or as a single executable
// built with `bun build --compile` (see scripts/build.ts). A compiled verdict
// has no source tree or node_modules on disk: files it needs at runtime are
// embedded, and it can act as the Bun it was built with.

// Modules of a compiled executable live in Bun's virtual filesystem:
// /$bunfs/… on macOS and Linux, B:\~BUN\… on Windows.
export const COMPILED = Bun.main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(Bun.main);

// How to run Bun: the one on PATH, or else this executable itself, which
// behaves as the Bun CLI when BUN_BE_BUN is set.
export function bunCommand(onPath: string | null): { bin: string; env: Record<string, string>; readable: string[] } {
  if (onPath) return { bin: onPath, env: {}, readable: [] };
  // Only the executable itself is readable in a sandbox, not the folder it's
  // in: that may be ~/Downloads, or home itself.
  if (!COMPILED) return { bin: process.execPath, env: {}, readable: [process.execPath] };
  return { bin: process.execPath, env: { BUN_BE_BUN: "1" }, readable: [process.execPath] };
}
