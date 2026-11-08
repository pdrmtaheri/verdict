// Decision models. jev goes through TypeSafe's own provider
// (TYPESAFE_AI_API_KEY). Language models are reached through the coding
// agents in src/agents/ instead.
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Experimental_DecisionModel } from "ai";

// Pinned: "jev-latest" moves with each release, which would change check
// results without any change to the repo.
export const DEFAULT_DECISION_MODEL = "jev-1.14.0";

// Tests swap in a mock decision model here.
export const overrides: { decision?: Experimental_DecisionModel } = {};

export function decisionModel(id = process.env.VERDICT_DECISION_MODEL ?? DEFAULT_DECISION_MODEL): Experimental_DecisionModel {
  if (overrides.decision) return overrides.decision;
  if (!process.env.TYPESAFE_AI_API_KEY) {
    throw new Error("TYPESAFE_AI_API_KEY is not set, so decision-model enforcers can't run: set it to your TypeSafe AI key, then run verdict check again");
  }
  return typeSafeAi.decisionModel(id);
}
