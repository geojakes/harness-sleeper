/**
 * sleeper.yaml schema, parsing and strict validation.
 *
 * A config file is loaded once per absolute path and cached for the life of
 * the process (each hook invocation is a fresh process, so this is really
 * just "don't reparse the same file twice within one call").
 */

import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { EventName, HarnessName, isEventName } from "./events.js";

/** How a rule dedupes repeat firings within a session. */
export type OnceMode = false | "path" | "rule";

/** Match conditions; every present key must match for the rule to fire. */
export interface MatchSpec {
  /** Glob patterns, relative to the config file's directory. "!" negates. */
  path?: string[];
  /** Regex tested against the event's shell command. */
  command?: RegExp;
  /** Regex tested against the event's prompt text. */
  prompt?: RegExp;
  /** Regex tested against the event's harness-native tool name. */
  tool?: RegExp;
  /** Restrict to these harnesses. */
  harness?: HarnessName[];
}

export interface InjectAction {
  inject: string;
}
export interface BlockAction {
  block: string;
}
export interface RunAction {
  run: string;
  inject_output?: boolean;
  timeout?: number;
}
export interface LogAction {
  log: string;
}

export type RuleAction = InjectAction | BlockAction | RunAction | LogAction;

export interface Rule {
  name: string;
  on: EventName[];
  match?: MatchSpec;
  once: OnceMode;
  actions: RuleAction[];
}

export interface SleeperConfig {
  version: number;
  rules: Rule[];
  /** Absolute path to the config file itself. */
  path: string;
  /** Absolute directory containing the config file; rules are scoped to it. */
  dir: string;
}

/** Thrown for any malformed or invalid sleeper.yaml. Message includes file + location. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const HARNESS_NAMES: readonly HarnessName[] = ["claude", "cursor", "generic"];

function isHarnessName(value: unknown): value is HarnessName {
  return typeof value === "string" && (HARNESS_NAMES as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locate(filePath: string, ruleIndex: number | null, ruleName: string | null): string {
  if (ruleIndex === null) return filePath;
  const label = ruleName ? ` (${ruleName})` : "";
  return `${filePath}: rule[${ruleIndex}]${label}`;
}

function fail(filePath: string, ruleIndex: number | null, ruleName: string | null, message: string): never {
  throw new ConfigError(`${locate(filePath, ruleIndex, ruleName)}: ${message}`);
}

function asStringArray(
  value: unknown,
  filePath: string,
  ruleIndex: number,
  ruleName: string | null,
  field: string,
): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value as string[];
  }
  fail(filePath, ruleIndex, ruleName, `"${field}" must be a string or list of strings`);
}

function compileRegex(
  value: unknown,
  filePath: string,
  ruleIndex: number,
  ruleName: string | null,
  field: string,
): RegExp {
  if (typeof value !== "string") {
    fail(filePath, ruleIndex, ruleName, `match.${field} must be a string (regular expression)`);
  }
  try {
    return new RegExp(value);
  } catch (err) {
    fail(filePath, ruleIndex, ruleName, `match.${field} is not a valid regular expression: ${(err as Error).message}`);
  }
}

function parseMatch(
  raw: unknown,
  filePath: string,
  ruleIndex: number,
  ruleName: string | null,
): MatchSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail(filePath, ruleIndex, ruleName, `"match" must be a mapping`);

  const allowed = new Set(["path", "command", "prompt", "tool", "harness"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(filePath, ruleIndex, ruleName, `unknown match key "${key}"`);
  }

  const match: MatchSpec = {};
  if (raw.path !== undefined) {
    match.path = asStringArray(raw.path, filePath, ruleIndex, ruleName, "match.path");
  }
  if (raw.command !== undefined) {
    match.command = compileRegex(raw.command, filePath, ruleIndex, ruleName, "command");
  }
  if (raw.prompt !== undefined) {
    match.prompt = compileRegex(raw.prompt, filePath, ruleIndex, ruleName, "prompt");
  }
  if (raw.tool !== undefined) {
    match.tool = compileRegex(raw.tool, filePath, ruleIndex, ruleName, "tool");
  }
  if (raw.harness !== undefined) {
    const harnesses = asStringArray(raw.harness, filePath, ruleIndex, ruleName, "match.harness");
    for (const h of harnesses) {
      if (!isHarnessName(h)) {
        fail(filePath, ruleIndex, ruleName, `match.harness has unknown harness "${h}" (expected claude, cursor or generic)`);
      }
    }
    match.harness = harnesses as HarnessName[];
  }
  return match;
}

function parseOn(raw: unknown, filePath: string, ruleIndex: number, ruleName: string | null): EventName[] {
  const values = asStringArray(raw, filePath, ruleIndex, ruleName, "on");
  if (values.length === 0) fail(filePath, ruleIndex, ruleName, `"on" must list at least one event`);
  for (const v of values) {
    if (!isEventName(v)) fail(filePath, ruleIndex, ruleName, `unknown event name "${v}" in "on"`);
  }
  return values as EventName[];
}

function parseOnce(raw: unknown, filePath: string, ruleIndex: number, ruleName: string | null): OnceMode {
  if (raw === undefined || raw === false) return false;
  if (raw === true) return "path";
  if (raw === "path" || raw === "rule") return raw;
  fail(filePath, ruleIndex, ruleName, `"once" must be false, true, "path" or "rule"`);
}

function parseActions(
  raw: unknown,
  filePath: string,
  ruleIndex: number,
  ruleName: string | null,
): RuleAction[] {
  if (!Array.isArray(raw)) fail(filePath, ruleIndex, ruleName, `"actions" must be a list`);
  if (raw.length === 0) fail(filePath, ruleIndex, ruleName, `"actions" must have at least one entry`);

  return raw.map((entry, actionIndex) => {
    if (!isPlainObject(entry)) {
      fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}] must be a mapping`);
    }
    const keys = Object.keys(entry);
    const kind = keys.find((k) => k === "inject" || k === "block" || k === "run" || k === "log");
    if (!kind) {
      fail(
        filePath,
        ruleIndex,
        ruleName,
        `actions[${actionIndex}] must have exactly one of "inject", "block", "run" or "log"`,
      );
    }
    const allowed = kind === "run" ? new Set(["run", "inject_output", "timeout"]) : new Set([kind]);
    for (const key of keys) {
      if (!allowed.has(key)) {
        fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}] has unknown key "${key}" for a "${kind}" action`);
      }
    }

    if (kind === "inject") {
      if (typeof entry.inject !== "string") fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}].inject must be a string`);
      return { inject: entry.inject };
    }
    if (kind === "block") {
      if (typeof entry.block !== "string") fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}].block must be a string`);
      return { block: entry.block };
    }
    if (kind === "log") {
      if (typeof entry.log !== "string") fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}].log must be a string`);
      return { log: entry.log };
    }

    // run
    if (typeof entry.run !== "string") fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}].run must be a string`);
    const action: RunAction = { run: entry.run };
    if (entry.inject_output !== undefined) {
      if (typeof entry.inject_output !== "boolean") {
        fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}].inject_output must be a boolean`);
      }
      action.inject_output = entry.inject_output;
    }
    if (entry.timeout !== undefined) {
      if (typeof entry.timeout !== "number" || entry.timeout <= 0) {
        fail(filePath, ruleIndex, ruleName, `actions[${actionIndex}].timeout must be a positive number`);
      }
      action.timeout = entry.timeout;
    }
    return action;
  });
}

function parseRule(raw: unknown, filePath: string, ruleIndex: number): Rule {
  if (!isPlainObject(raw)) fail(filePath, ruleIndex, null, `rule must be a mapping`);

  const nameValue = raw.name;
  if (typeof nameValue !== "string" || nameValue.trim() === "") {
    fail(filePath, ruleIndex, null, `rule is missing a "name"`);
  }
  const ruleName = nameValue;

  const knownKeys = new Set(["name", "on", "match", "once", "actions"]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) fail(filePath, ruleIndex, ruleName, `unknown rule key "${key}"`);
  }

  if (raw.on === undefined) fail(filePath, ruleIndex, ruleName, `rule is missing "on"`);
  if (raw.actions === undefined) fail(filePath, ruleIndex, ruleName, `rule is missing "actions"`);

  return {
    name: ruleName,
    on: parseOn(raw.on, filePath, ruleIndex, ruleName),
    match: parseMatch(raw.match, filePath, ruleIndex, ruleName),
    once: parseOnce(raw.once, filePath, ruleIndex, ruleName),
    actions: parseActions(raw.actions, filePath, ruleIndex, ruleName),
  };
}

/** Parse and strictly validate config text. `filePath`/`dir` are attached to the result. */
export function parseConfig(text: string, filePath: string, dir: string): SleeperConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${filePath}: could not parse YAML: ${(err as Error).message}`);
  }

  if (!isPlainObject(raw)) throw new ConfigError(`${filePath}: config must be a mapping`);

  if (raw.version !== 1) {
    throw new ConfigError(`${filePath}: "version" must be 1`);
  }
  if (raw.rules === undefined) {
    throw new ConfigError(`${filePath}: missing "rules"`);
  }
  if (!Array.isArray(raw.rules)) {
    throw new ConfigError(`${filePath}: "rules" must be a list`);
  }

  const rules = raw.rules.map((entry, index) => parseRule(entry, filePath, index));

  const seenNames = new Set<string>();
  for (const rule of rules) {
    if (seenNames.has(rule.name)) {
      throw new ConfigError(`${filePath}: duplicate rule name "${rule.name}"`);
    }
    seenNames.add(rule.name);
  }

  return { version: 1, rules, path: filePath, dir };
}

const configCache = new Map<string, { mtimeMs: number; config: SleeperConfig }>();

/** Load a config from disk, validating strictly. Cached per process, keyed by mtime. */
export function loadConfig(filePath: string, dir: string): SleeperConfig {
  const stat = fs.statSync(filePath);
  const cached = configCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config;

  const text = fs.readFileSync(filePath, "utf8");
  const config = parseConfig(text, filePath, dir);
  configCache.set(filePath, { mtimeMs: stat.mtimeMs, config });
  return config;
}

/** Clear the process-wide config cache. Mainly useful in tests. */
export function clearConfigCache(): void {
  configCache.clear();
}
