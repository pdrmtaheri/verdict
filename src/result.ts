export type Status = "pass" | "fail" | "inconclusive";

export interface Result {
  status: Status;
  message: string;
  warnings?: string[]; // changes the enforcer noticed that don't decide its status
}

export const pass = (message = ""): Result => ({ status: "pass", message });
export const fail = (message: string): Result => ({ status: "fail", message });
export const inconclusive = (message: string): Result => ({ status: "inconclusive", message });

// A law fails if any enforcer fails; otherwise it is inconclusive if any is.
export function combine(results: Result[]): Status {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "inconclusive")) return "inconclusive";
  return "pass";
}
