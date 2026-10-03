#!/usr/bin/env node
// DEVELOPMENT ONLY (scripts/dev-stack): starts one long-running process of the local stack in its own session (setsid,
// so closing the terminal or a Ctrl-C in it never stops it), appends stdout and stderr to a log file and writes the pid
// file. Every argument comes from up.sh (fixed commands, never user data).
// Usage: node spawn-detached.mjs <cwd> <log file> <pid file> -- <command> [args...]
/* global process, console */

import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";

const separator = process.argv.indexOf("--");
const [cwd, logFile, pidFile] = process.argv.slice(2, separator);
const command = process.argv.slice(separator + 1);
if (separator < 0 || !cwd || !logFile || !pidFile || command.length === 0) {
  console.error("usage: spawn-detached.mjs <cwd> <log file> <pid file> -- <command> [args...]");
  process.exit(2);
}

const log = openSync(logFile, "a");
const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ["ignore", log, log], env: process.env });
child.once("error", (error) => {
  console.error(`could not start ${command[0]}: ${error.message}`);
  process.exit(1);
});
child.once("spawn", () => {
  writeFileSync(pidFile, `${child.pid}\n`);
  closeSync(log);
  child.unref();
  process.exit(0);
});
