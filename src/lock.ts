// VERDICT.lock: law hash -> { law, enforcers: [{ <kind>: <path>, ... }] }.
// Besides its kind and path, an enforcer may record:
//   name    the test to run in a file that has others (tests outside .verdict/)
//   rule    for a lint enforcer, the rule in the project's linter config
//   scope   what it covers, when the file can't say (files verdict doesn't own)
//   inputs  what it was proven against: a fingerprint of the enforcer file and
//           of the config it runs under (see pins.ts). When they differ, check
//           replays the enforcer's break before trusting a pass.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import YAML, { YAMLParseError } from "yaml";
import { z } from "zod";
import type { Law } from "./laws.ts";
import type { Inputs } from "./pins.ts";

export interface Enforcer {
  kind: string;
  path: string;
  name?: string;
  rule?: string;
  scope?: string;
  inputs?: Inputs;
}

// Which enforcer a break or a result belongs to. Two enforcers can share a
// path (two rules of one linter config, two tests in one file), so the rule
// or the test's name is part of it: "eslint.config.js#no-var".
export const enforcerId = (e: Enforcer): string => (e.rule ? `${e.path}#${e.rule}` : e.name ? `${e.path}#${e.name}` : e.path);

export interface LockEntry {
  law: string;
  enforcers: Enforcer[];
}

export type Lock = Map<string, LockEntry>;

const FIELDS = new Set(["name", "rule", "scope", "inputs"]);

// A lock verdict can't read: a merge conflict, a hand edit gone wrong.
export class BadLock extends Error {}

// What a lock must look like for verdict to read it. Enforcers are read
// leniently: each is "<kind>: <path>" plus the optional fields.
const LockFile = z.record(z.string(), z.object({ law: z.string(), enforcers: z.array(z.unknown()).optional() }));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readEnforcer(e: unknown): Enforcer[] {
  if (!isRecord(e)) return [];
  const kind = Object.keys(e).find((k) => !FIELDS.has(k));
  if (!kind) return [];
  const out: Enforcer = { kind, path: String(e[kind]) };
  if (typeof e.name === "string") out.name = e.name;
  if (typeof e.rule === "string") out.rule = e.rule;
  if (typeof e.scope === "string") out.scope = e.scope;
  if (isRecord(e.inputs)) out.inputs = Object.fromEntries(Object.entries(e.inputs).map(([k, v]) => [k, String(v)]));
  return [out];
}

export function readLock(file: string): Lock {
  const lock: Lock = new Map();
  if (!existsSync(file)) return lock;
  const fix = "restore it from git (`git checkout -- VERDICT.lock`), or delete it and run `verdict plan` to plan every law again";
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (err) {
    const where = err instanceof YAMLParseError ? err.linePos?.[0].line : undefined;
    throw new BadLock(`${file} is not valid YAML${where ? ` (line ${where})` : ""}: ${fix}`, { cause: err });
  }
  const raw = LockFile.safeParse(parsed);
  if (!raw.success) throw new BadLock(`${file} isn't a verdict lock (each entry needs a law and a list of enforcers): ${fix}`);
  for (const [hash, entry] of Object.entries(raw.data)) {
    lock.set(hash, { law: entry.law, enforcers: (entry.enforcers ?? []).flatMap(readEnforcer) });
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
        ...(e.rule ? { rule: e.rule } : {}),
        ...(e.scope ? { scope: e.scope } : {}),
        ...(e.inputs ? { inputs: e.inputs } : {}),
      })),
    };
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(doc, { lineWidth: 80 }));
  renameSync(tmp, file);
}
