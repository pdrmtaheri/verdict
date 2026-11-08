// Provider-agnostic model lookup. IDs are "provider:model", e.g.
// "anthropic:claude-opus-5-5", "openai:gpt-6", "typesafe:jev-latest".
// Unknown providers go through Vercel AI Gateway ("gateway:<id>").
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createProviderRegistry, gateway, type LanguageModel, type Experimental_DecisionModel } from "ai";

const registry = createProviderRegistry({ anthropic, openai, google, typesafe: typeSafeAi, gateway });

type RegistryId = Parameters<typeof registry.languageModel>[0];

export const DEFAULT_MODEL = "anthropic:claude-opus-5-5";
export const DEFAULT_DECISION_MODEL = "typesafe:jev-latest";

// Tests swap in mock models here.
export const overrides: { language?: LanguageModel; decision?: Experimental_DecisionModel } = {};

export function languageModel(id = process.env.VERDICT_MODEL ?? DEFAULT_MODEL): LanguageModel {
  return overrides.language ?? registry.languageModel(id as RegistryId);
}

export function decisionModel(
  id = process.env.VERDICT_DECISION_MODEL ?? DEFAULT_DECISION_MODEL,
): Experimental_DecisionModel {
  return overrides.decision ?? registry.decisionModel(id as RegistryId);
}
