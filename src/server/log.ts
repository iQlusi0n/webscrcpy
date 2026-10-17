/** `<ISO> [tag] [LEVEL] msg` to stdout (info/debug) or stderr (warn/error). No files, no rotation. */
import type { Logger } from "./app.ts";

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

const DEBUG_ENABLED = process.env["DEBUG"] === "1";

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function emit(tag: string, level: Level, msg: string, args: unknown[]): void {
  const rest = args.length ? " " + args.map(formatArg).join(" ") : "";
  const line = `${new Date().toISOString()} [${tag}] [${level}] ${msg}${rest}\n`;
  if (level === "WARN" || level === "ERROR") process.stderr.write(line);
  else process.stdout.write(line);
}

export function log(tag: string): Logger {
  return {
    info: (msg, ...args) => emit(tag, "INFO", msg, args),
    warn: (msg, ...args) => emit(tag, "WARN", msg, args),
    error: (msg, ...args) => emit(tag, "ERROR", msg, args),
    debug: (msg, ...args) => {
      if (DEBUG_ENABLED) emit(tag, "DEBUG", msg, args);
    },
  };
}
