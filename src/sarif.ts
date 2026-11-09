// `verdict check --format sarif`: the report as SARIF 2.1.0, so failures show
// up where a project's other linters report (GitHub code scanning, IDEs).
// One rule per law; one result per enforcer that didn't pass, and per warning.
import { join } from "node:path";
import type { LawReport } from "./check.ts";
import { posixRelative, type Where } from "./where.ts";

const LEVEL = { fail: "error", inconclusive: "note", pass: "none" } as const;

export function sarif(repo: string, sets: { where: Where; lawsFile: string; reports: LawReport[] }[]): object {
  const rules: object[] = [];
  const results: object[] = [];
  const uri = (w: Where, path: string) => posixRelative(repo, join(w.dir, path));
  for (const { where, lawsFile, reports } of sets) {
    for (const r of reports) {
      const id = `${posixRelative(repo, where.dir) || "."}:${r.hash ?? r.law.slice(0, 40)}`;
      rules.push({ id, name: r.hash, shortDescription: { text: r.law }, fullDescription: { text: r.law } });
      if (r.status === "unplanned") {
        results.push({
          ruleId: id,
          level: "error",
          message: { text: `Not planned: run \`verdict plan\` (new law, or its wording changed). Law: ${r.law}` },
          locations: [{ physicalLocation: { artifactLocation: { uri: posixRelative(repo, lawsFile) } } }],
        });
      }
      for (const d of r.details) {
        const location = [{ physicalLocation: { artifactLocation: { uri: uri(where, d.path) } } }];
        if (d.result.status !== "pass") {
          results.push({ ruleId: id, level: LEVEL[d.result.status], message: { text: `${r.law}\n\n${d.kind} ${d.path}: ${d.result.status}\n${d.result.message}`.trim() }, locations: location });
        }
        for (const w of d.warnings) results.push({ ruleId: id, level: "warning", message: { text: `${d.kind} ${d.path}: ${w}` }, locations: location });
      }
    }
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "verdict", informationUri: "https://github.com/pdrmtaheri/verdict", rules } }, results }],
  };
}
