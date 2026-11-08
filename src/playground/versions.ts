// Versions: different code for the same laws. The playground's own code
// directories (public/, test/ ...) are the "main" version. Every other version
// is a folder versions/<id>/ with the same layout. Running the laws on a version
// changes nothing on disk: each enforcer is told where the code is (its
// target), and looks there. Laws, enforcers, breaks and the lock are shared.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inside } from "../tools.ts";
import type { Manifest } from "./manifest.ts";

export const MAIN = "main";

export interface VersionInfo {
  id: string;
  label: string;
  note: string;
}

export const codeDirs = (m: Manifest): string[] => m.writable.filter((d) => d !== ".verdict");

export function versionList(root: string, m: Manifest): VersionInfo[] {
  const list: VersionInfo[] = [{ id: MAIN, label: m.main?.label ?? "main", note: m.main?.note ?? "" }];
  const dir = join(root, "versions");
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort() : [];
  const declared = m.versions ?? [];
  for (const v of declared) if (onDisk.includes(v.id)) list.push({ id: v.id, label: v.label ?? v.id, note: v.note ?? "" });
  for (const id of onDisk) if (!list.some((v) => v.id === id)) list.push({ id, label: id, note: "" });
  return list;
}

export function hasVersion(root: string, m: Manifest, id: string): boolean {
  return versionList(root, m).some((v) => v.id === id);
}

// Where a version keeps one of its code directories.
export const codePath = (root: string, version: string, dir: string) => (version === MAIN ? join(root, dir) : join(root, "versions", version, dir));

// The folder of code a version's checks should look at: the playground itself
// for main, versions/<id>/ for the others.
export function versionTarget(root: string, m: Manifest, version: string): string {
  if (!hasVersion(root, m, version)) throw new Error(`there is no version "${version}": use one of ${versionList(root, m).map((v) => v.id).join(", ")}`);
  return version === MAIN ? root : inside(root, join("versions", version)); // a link out of the playground is refused
}
