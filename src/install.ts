/**
 * Installs/uninstalls sleeper's hooks into a harness's own settings file.
 * Idempotent: re-running install replaces sleeper's own entries in place and
 * never touches unrelated hooks or settings.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface InstallOptions {
  global?: boolean;
  command?: string;
  cwd?: string;
}

type JsonRecord = Record<string, unknown>;

function readJsonOrEmpty(file: string): JsonRecord {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").trim();
  if (text === "") return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object`);
  }
  return parsed as JsonRecord;
}

function writeJson(file: string, data: JsonRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function baseDir(opts: InstallOptions): string {
  return opts.global ? os.homedir() : opts.cwd ?? process.cwd();
}

export function claudeSettingsPath(opts: InstallOptions): string {
  return path.join(baseDir(opts), ".claude", "settings.json");
}

export function cursorHooksPath(opts: InstallOptions): string {
  return path.join(baseDir(opts), ".cursor", "hooks.json");
}

const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];

interface ClaudeHookEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface ClaudeMatcherGroup {
  matcher?: string;
  hooks?: ClaudeHookEntry[];
  [key: string]: unknown;
}

function isSleeperClaudeCommand(command: unknown): boolean {
  return typeof command === "string" && command.endsWith(" hook claude");
}

function stripSleeperClaudeGroups(groups: ClaudeMatcherGroup[]): ClaudeMatcherGroup[] {
  return groups
    .map((group) => {
      if (!Array.isArray(group.hooks)) return group;
      return { ...group, hooks: group.hooks.filter((h) => !isSleeperClaudeCommand(h.command)) };
    })
    .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
}

/** Install sleeper's Claude Code hooks into `.claude/settings.json`, preserving everything else. */
export function installClaude(opts: InstallOptions): { target: string } {
  const target = claudeSettingsPath(opts);
  const settings = readJsonOrEmpty(target);
  const cmd = opts.command ?? "sleeper";
  const fullCommand = `${cmd} hook claude`;

  const hooks: JsonRecord = typeof settings.hooks === "object" && settings.hooks !== null ? { ...(settings.hooks as JsonRecord) } : {};
  for (const evt of CLAUDE_EVENTS) {
    const existing = Array.isArray(hooks[evt]) ? (hooks[evt] as ClaudeMatcherGroup[]) : [];
    const kept = stripSleeperClaudeGroups(existing);
    kept.push({ matcher: "*", hooks: [{ type: "command", command: fullCommand, timeout: 30 }] });
    hooks[evt] = kept;
  }
  settings.hooks = hooks;

  writeJson(target, settings);
  return { target };
}

/** Remove sleeper's Claude Code hooks from `.claude/settings.json`, leaving everything else intact. */
export function uninstallClaude(opts: InstallOptions): { target: string } {
  const target = claudeSettingsPath(opts);
  if (!fs.existsSync(target)) return { target };
  const settings = readJsonOrEmpty(target);

  if (typeof settings.hooks === "object" && settings.hooks !== null) {
    const hooks = { ...(settings.hooks as JsonRecord) };
    for (const evt of CLAUDE_EVENTS) {
      if (!Array.isArray(hooks[evt])) continue;
      const kept = stripSleeperClaudeGroups(hooks[evt] as ClaudeMatcherGroup[]);
      if (kept.length > 0) hooks[evt] = kept;
      else delete hooks[evt];
    }
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
  }

  writeJson(target, settings);
  return { target };
}

const CURSOR_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "beforeReadFile",
  "afterFileEdit",
  "beforeShellExecution",
  "afterShellExecution",
  "preToolUse",
  "postToolUse",
  "stop",
  "sessionEnd",
];

interface CursorHookEntry {
  command: string;
  [key: string]: unknown;
}

function isSleeperCursorCommand(command: unknown): boolean {
  return typeof command === "string" && command.endsWith(" hook cursor");
}

/** Install sleeper's Cursor hooks into `.cursor/hooks.json`, preserving everything else. */
export function installCursor(opts: InstallOptions): { target: string } {
  const target = cursorHooksPath(opts);
  const settings = readJsonOrEmpty(target);
  const cmd = opts.command ?? "sleeper";
  const fullCommand = `${cmd} hook cursor`;

  settings.version = 1;
  const hooks: JsonRecord = typeof settings.hooks === "object" && settings.hooks !== null ? { ...(settings.hooks as JsonRecord) } : {};
  for (const evt of CURSOR_EVENTS) {
    const existing = Array.isArray(hooks[evt]) ? (hooks[evt] as CursorHookEntry[]) : [];
    const kept = existing.filter((h) => !isSleeperCursorCommand(h.command));
    kept.push({ command: fullCommand });
    hooks[evt] = kept;
  }
  settings.hooks = hooks;

  writeJson(target, settings);
  return { target };
}

/** Remove sleeper's Cursor hooks from `.cursor/hooks.json`, leaving everything else intact. */
export function uninstallCursor(opts: InstallOptions): { target: string } {
  const target = cursorHooksPath(opts);
  if (!fs.existsSync(target)) return { target };
  const settings = readJsonOrEmpty(target);

  if (typeof settings.hooks === "object" && settings.hooks !== null) {
    const hooks = { ...(settings.hooks as JsonRecord) };
    for (const evt of CURSOR_EVENTS) {
      if (!Array.isArray(hooks[evt])) continue;
      const kept = (hooks[evt] as CursorHookEntry[]).filter((h) => !isSleeperCursorCommand(h.command));
      if (kept.length > 0) hooks[evt] = kept;
      else delete hooks[evt];
    }
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
  }

  writeJson(target, settings);
  return { target };
}
