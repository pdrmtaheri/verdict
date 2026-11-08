// VERDICT.lock: law hash -> { law, enforcers: [{ <kind>: <path> }] }.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { Law } from "./laws.ts";

export interface Enforcer {
  kind: string;
  path: string;
}

export interface LockEntry {
  law: string;
  enforcers: Enforcer[];
}

export type Lock = Map<string, LockEntry>;

export function readLock(file: string): Lock {
  const lock: Lock = new Map();
  if (!existsSync(file)) return lock;
  const raw = (YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<
    string,
    { law: string; enforcers?: Record<string, string>[] }
  >;
  for (const [hash, entry] of Object.entries(raw)) {
    const enforcers = (entry.enforcers ?? []).flatMap((e) =>
      Object.entries(e).map(([kind, path]) => ({ kind, path: String(path) })),
    );
    lock.set(String(hash), { law: String(entry.law), enforcers });
  }
  return lock;
}

// Entries are written in the order the laws appear in VERDICT.md. The file is
// replaced in one rename, so a reader never sees half of it.
export function writeLock(file: string, lock: Lock, laws: Law[]): void {
  const doc: Record<string, unknown> = {};
  for (const { hash } of laws) {
    const entry = lock.get(hash);
    if (!entry) continue;
    doc[hash] = {
      law: entry.law,
      enforcers: entry.enforcers.map((e) => ({ [e.kind]: e.path })),
    };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(doc, { lineWidth: 80 }));
  renameSync(tmp, file);
}
