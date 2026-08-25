import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { config } from "../utils/config.js";
import { loadEnvFile, requireEnv } from "../utils/env.js";

/** The single place where the OpenRouter credentials are read. */
export function createReviewModel(): LanguageModel {
  loadEnvFile();

  const openrouter = createOpenRouter({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
  });

  return openrouter(config.model);
}
