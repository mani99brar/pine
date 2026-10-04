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

// A minimal environment: every setting comes from the --env-file of the command (node --env-file never overrides a
// variable that is already set, so a developer's exported PINE_* or DATABASE_URL must not leak into the dev services).
const KEEP = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"];
const env = Object.fromEntries(KEEP.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const log = openSync(logFile, "a");
const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ["ignore", log, log], env });
child.once("error", (error) => {
  console.error(`could not start ${command[0]}: ${error.message}`);
  process.exit(1);
});
child.once("spawn", () => {
  // The command line is recorded with the pid so a reused pid (after a reboot) is never taken for the service.
  writeFileSync(pidFile, `${child.pid}\n${command.join(" ")}\n`);
  closeSync(log);
  child.unref();
  process.exit(0);
});
