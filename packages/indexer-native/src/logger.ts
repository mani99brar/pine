// pino logger whose every string (message and nested fields) passes through the redactor before it is written.

import { pino, type DestinationStream, type Logger as PinoLogger } from "pino";
import type { Redactor } from "./redact.js";

function redactValue(value: unknown, redact: Redactor, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object" || depth > 5) return value instanceof Error ? redact(value.name) : value;
  if (value instanceof Error) return redact(value.name);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[key] = redactValue(item, redact, depth + 1);
  return out;
}

export function createLogger(redact: Redactor, level: string, destination?: DestinationStream): PinoLogger {
  const options = {
    level,
    base: { service: "pine-indexer-native" },
    hooks: {
      logMethod(this: PinoLogger, args: Parameters<PinoLogger["info"]>, method: (...input: unknown[]) => void) {
        method.apply(this, (args as unknown[]).map((arg) => redactValue(arg, redact)));
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
