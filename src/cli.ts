#!/usr/bin/env node
/**
 * `sleeper` CLI entry point. Hand-rolled argument parsing, no dependency
 * beyond `yaml` (used deeper in the config loader).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAllConfigs } from "./discover.js";
import { ConfigError } from "./config.js";
import { resolveStateDir } from "./state.js";
import { runHook } from "./harness/index.js";
import { claudeAdapter } from "./harness/claude.js";
import { cursorAdapter } from "./harness/cursor.js";
import { genericAdapter, type GenericRawInput } from "./harness/generic.js";
import { installClaude, installCursor, uninstallClaude, uninstallCursor } from "./install.js";

const USAGE = `sleeper - hook AI coding harnesses into deterministic rules

Usage:
  sleeper init                          Write a starter sleeper.yaml in the current directory
  sleeper check [dir]                   Validate every sleeper.yaml under dir (default: cwd)
  sleeper events [options]              Print session event logs
      --session <id>                    Only this session id
      --harness <name>                  Only this harness (claude|cursor|generic)
      --workspace <dir>                 Workspace whose state dir to read (default: cwd)
  sleeper hook claude                   Run the Claude Code hook adapter (reads JSON on stdin)
  sleeper hook cursor                   Run the Cursor hook adapter (reads JSON on stdin)
  sleeper emit <event> [options]        Emit one event from a generic/shell-based harness
      --path <p> --command <c> --prompt <t> --tool <name> --output <text>
      --session <id> --workspace <dir> --harness <name>
  sleeper install claude|cursor [options]    Install sleeper's hooks
  sleeper uninstall claude|cursor [options]  Remove sleeper's hooks
      --global                          Use the user-level settings file
      --command <cmd>                   Command to invoke (default: sleeper)
  sleeper --help                        Show this help
  sleeper --version                     Show the installed version
`;

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function printVersion(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}

/** Parse `--flag value` pairs (and bare `--flag` boolean switches) from argv. */
function parseFlags(args: string[], boolFlags: Set<string> = new Set()): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (boolFlags.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) continue;
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

const STARTER_CONFIG = `version: 1
rules:
  - name: example-rule
    on: file.read
    match:
      path: "src/**"
    once: path
    actions:
      - inject: "Reminder: {{relpath}} was just read."
`;

function cmdInit(): void {
  const target = path.join(process.cwd(), "sleeper.yaml");
  if (fs.existsSync(target)) {
    console.error(`sleeper: ${target} already exists, not overwriting`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(target, STARTER_CONFIG);
  console.log(`Wrote ${target}`);
  console.log("Edit it to add your own rules, then run `sleeper check` to validate.");
}

function cmdCheck(args: string[]): void {
  const dir = path.resolve(args[0] ?? process.cwd());
  try {
    const configs = discoverAllConfigs(dir);
    if (configs.length === 0) {
      console.log(`No sleeper.yaml found under ${dir}`);
      return;
    }
    for (const config of configs) {
      console.log(config.path);
      for (const rule of config.rules) {
        const on = rule.on.join(",");
        const once = rule.once === false ? "false" : rule.once;
        console.log(`  - ${rule.name}  on=${on}  once=${once}`);
      }
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function cmdEvents(args: string[]): void {
  const flags = parseFlags(args);
  const workspace = path.resolve(flags.get("workspace") ?? process.cwd());
  const stateDir = resolveStateDir(workspace);
  if (!fs.existsSync(stateDir)) {
    console.log(`No state directory at ${stateDir}`);
    return;
  }

  const session = flags.get("session");
  const harness = flags.get("harness");

  const files = fs
    .readdirSync(stateDir)
    .filter((f) => f.endsWith(".events.jsonl"))
    .filter((f) => {
      if (harness && !f.startsWith(`${harness}-`)) return false;
      if (session) {
        const sanitised = session.replace(/[^a-zA-Z0-9._-]/g, "_") || "session";
        if (!f.includes(`-${sanitised}.events.jsonl`)) return false;
      }
      return true;
    })
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(stateDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.log("No matching session event logs");
    return;
  }

  for (const file of files) {
    console.log(`# ${file.name}`);
    const content = fs.readFileSync(path.join(stateDir, file.name), "utf8");
    process.stdout.write(content);
  }
}

function cmdHook(args: string[]): void {
  const which = args[0];
  const raw = readStdinSync();
  try {
    let out: string | null;
    if (which === "claude") {
      out = runHook(claudeAdapter, raw);
    } else if (which === "cursor") {
      out = runHook(cursorAdapter, raw);
    } else {
      console.error(`sleeper: unknown hook harness "${which ?? ""}" (expected claude or cursor)`);
      process.exitCode = 1;
      return;
    }
    if (out) process.stdout.write(out + "\n");
  } catch (err) {
    // A sleeper bug must never break the harness it is hooked into.
    process.stderr.write(`sleeper: ${(err as Error).message}\n`);
  }
}

function cmdEmit(args: string[]): void {
  const event = args[0];
  if (!event) {
    console.error("sleeper: emit requires an event name");
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args.slice(1));
  const input: GenericRawInput = {
    event,
    path: flags.get("path"),
    command: flags.get("command"),
    prompt: flags.get("prompt"),
    tool: flags.get("tool"),
    output: flags.get("output"),
    session: flags.get("session"),
    workspace: flags.get("workspace"),
    harness: flags.get("harness"),
  };

  try {
    const out = runHook(genericAdapter, JSON.stringify(input));
    const text = out ?? JSON.stringify({ inject: [], block: null, log: [] });
    process.stdout.write(text + "\n");
    const parsed = JSON.parse(text) as { block: unknown };
    process.exitCode = parsed.block ? 3 : 0;
  } catch (err) {
    process.stderr.write(`sleeper: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

function cmdInstall(args: string[], uninstall: boolean): void {
  const which = args[0];
  const flags = parseFlags(args.slice(1), new Set(["global"]));
  const opts = { global: flags.get("global") === "true", command: flags.get("command") };

  if (which !== "claude" && which !== "cursor") {
    console.error(`sleeper: expected "claude" or "cursor", got "${which ?? ""}"`);
    process.exitCode = 1;
    return;
  }

  if (which === "claude") {
    const { target } = uninstall ? uninstallClaude(opts) : installClaude(opts);
    console.log(`${uninstall ? "Removed" : "Wrote"} sleeper hooks in ${target}`);
  } else {
    const { target } = uninstall ? uninstallCursor(opts) : installCursor(opts);
    console.log(`${uninstall ? "Removed" : "Wrote"} sleeper hooks in ${target}`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "--version") {
    printVersion();
    return;
  }

  const rest = argv.slice(1);
  switch (command) {
    case "init":
      return cmdInit();
    case "check":
      return cmdCheck(rest);
    case "events":
      return cmdEvents(rest);
    case "hook":
      return cmdHook(rest);
    case "emit":
      return cmdEmit(rest);
    case "install":
      return cmdInstall(rest, false);
    case "uninstall":
      return cmdInstall(rest, true);
    default:
      console.error(`sleeper: unknown command "${command}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main();
