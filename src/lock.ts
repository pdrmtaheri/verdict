// VERDICT.lock: law hash -> { law, enforcers: [{ <kind>: <path>, ... }] }.
// Besides its kind and path, an enforcer may record:
//   name    the test to run in a file that has others (tests outside .verdict/)
//   scope   what it covers, when the file can't say (files verdict doesn't own)
//   inputs  what it was proven against: a fingerprint of the enforcer file and
//           of the config it runs under (see pins.ts). When they differ, check
//           replays the enforcer's break before trusting a pass.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { Law } from "./laws.ts";
import type { Inputs } from "./pins.ts";

export interface Enforcer {
  kind: string;
  path: string;
  name?: string;
  scope?: string;
  inputs?: Inputs;
}

export interface LockEntry {
  law: string;
  enforcers: Enforcer[];
}

export type Lock = Map<string, LockEntry>;

const FIELDS = ["name", "scope", "inputs"];

export function readLock(file: string): Lock {
  const lock: Lock = new Map();
  if (!existsSync(file)) return lock;
  const raw = (YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<
    string,
    { law: string; enforcers?: Record<string, unknown>[] }
  >;
  for (const [hash, entry] of Object.entries(raw)) {
    const enforcers = (entry.enforcers ?? []).flatMap((e): Enforcer[] => {
      const kind = Object.keys(e).find((k) => !FIELDS.includes(k));
      if (!kind) return [];
      const out: Enforcer = { kind, path: String(e[kind]) };
      if (typeof e.name === "string") out.name = e.name;
      if (typeof e.scope === "string") out.scope = e.scope;
      if (e.inputs && typeof e.inputs === "object") {
        out.inputs = Object.fromEntries(Object.entries(e.inputs).map(([k, v]) => [k, String(v)]));
      }
      return [out];
    });
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
      enforcers: entry.enforcers.map((e) => ({
        [e.kind]: e.path,
        ...(e.name ? { name: e.name } : {}),
        ...(e.scope ? { scope: e.scope } : {}),
        ...(e.inputs ? { inputs: e.inputs } : {}),
      })),
    };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(doc, { lineWidth: 80 }));
  renameSync(tmp, file);
}
