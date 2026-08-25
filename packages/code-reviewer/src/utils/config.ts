import { readFileSync } from "node:fs";
import { z } from "zod";
import { fromProjectRoot } from "./paths.js";

const configSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
  logDirectory: z.string().min(1),
  appName: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;

function readConfig(): Config {
  const path = fromProjectRoot("config.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const result = configSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Invalid config.json:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}

export const config = readConfig();
