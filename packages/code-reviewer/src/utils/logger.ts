import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config.js";
import { fromProjectRoot } from "./paths.js";

type Level = "INFO" | "WARN" | "ERROR";

/** "2026-08-25 14:03:07" in local time. */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day} ${time}`;
}

function logFilePath(date: Date, logDirectory: string): string {
  return join(logDirectory, `${getConfig().appName}-${timestamp(date).slice(0, 10)}.log`);
}

function write(level: Level, message: string): void {
  const now = new Date();
  const line = `[${timestamp(now)}] [${level}] ${message}`;

  console.log(line);

  const logDirectory = fromProjectRoot(getConfig().logDirectory);
  mkdirSync(logDirectory, { recursive: true });
  appendFileSync(logFilePath(now, logDirectory), `${line}\n`, "utf8");
}

export const log = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARN", message),
  error: (message: string) => write("ERROR", message),
};
