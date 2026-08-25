import { existsSync } from "node:fs";
import { fromProjectRoot } from "./paths.js";

/** Loads .env into process.env. Missing file is fine - the key may come from the shell. */
export function loadEnvFile(): void {
  const path = fromProjectRoot(".env");
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
