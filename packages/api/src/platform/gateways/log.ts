// Gateway log lines. The frozen GatewayDependencies carry no logger, so lines go to an injectable sink (default: one JSON
// line on stderr). Every message is passed through the redactor here, so callers cannot forget it.

import type { Redactor } from "../../contracts/redact.js";

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: { level: LogLevel; component: string; msg: string }) => void;

export interface GatewayLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const stderrSink: LogSink = (line) => {
  process.stderr.write(`${JSON.stringify({ ...line, time: new Date().toISOString() })}\n`);
};

export function createLogger(sink: LogSink, redact: Redactor, component = "gateways"): GatewayLogger {
  const write = (level: LogLevel) => (msg: string) => sink({ level, component, msg: redact(msg) });
  return { info: write("info"), warn: write("warn"), error: write("error") };
}
