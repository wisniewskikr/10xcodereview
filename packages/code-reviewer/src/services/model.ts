import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { loadEnvFile, requireEnv } from "../utils/env.js";

/**
 * The single place where the OpenRouter credentials are read.
 *
 * The model id is a parameter, not a config lookup, so one process can hold
 * several reviewers on different models at once.
 */
export function createReviewModel(modelId: string): LanguageModel {
  loadEnvFile();

  const openrouter = createOpenRouter({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
  });

  return openrouter(modelId);
}
