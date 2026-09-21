/**
 * Rule engine: matches events against discovered configs and runs the
 * actions of every rule that fires.
 */

import path from "node:path";
import type { SleeperEvent } from "./events.js";
import type { Rule } from "./config.js";
import { discoverConfigsForEvent } from "./discover.js";
import { globMatchAny, normalisePath } from "./glob.js";
import { runActions, actionKind } from "./actions.js";
import type { SessionState } from "./state.js";

/** Record of one rule firing, written to the session's event log. */
export interface FiredRule {
  rule: string;
  config: string;
  actions: string[];
}

export interface Outcome {
  inject: string[];
  block: { reason: string; rule: string } | null;
  logs: string[];
  fired: FiredRule[];
}

export interface EngineContext {
  /** Absolute workspace root. */
  workspace: string;
  /** Mutated in place: `seen` gains an entry for every rule that fires with `once` set. */
  state: SessionState;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
}

function matchesRule(rule: Rule, event: SleeperEvent, relPath: string | undefined): boolean {
  const m = rule.match;
  if (!m) return true;

  if (m.harness && !m.harness.includes(event.harness)) return false;
  if (m.command && (event.command === undefined || !m.command.test(event.command))) return false;
  if (m.prompt && (event.prompt === undefined || !m.prompt.test(event.prompt))) return false;
  if (m.tool && (event.tool === undefined || !m.tool.test(event.tool))) return false;
  if (m.path) {
    if (relPath === undefined) return false;
    if (!globMatchAny(m.path, relPath)) return false;
  }
  return true;
}

function onceKey(configPath: string, rule: Rule, event: SleeperEvent): string | null {
  if (rule.once === false) return null;
  const scope = rule.once === "rule" ? "*" : event.path ?? "*";
  return `${configPath}::${rule.name}::${scope}`;
}

/** Evaluate a batch of events against every relevant config, mutating `ctx.state.seen`. */
export function evaluate(events: SleeperEvent[], ctx: EngineContext): Outcome {
  const outcome: Outcome = { inject: [], block: null, logs: [], fired: [] };
  const now = ctx.now ?? (() => new Date());
  const workspaceRoot = path.resolve(ctx.workspace);

  for (const event of events) {
    const configs = discoverConfigsForEvent(ctx.workspace, event.path);

    for (const config of configs) {
      const isRoot = path.resolve(config.dir) === workspaceRoot;

      for (const rule of config.rules) {
        if (!rule.on.includes(event.event)) continue;

        let relPath: string | undefined;
        if (event.path) {
          const rel = path.relative(config.dir, event.path);
          const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
          if (!isRoot && !inside) continue; // out of this config's scope
          relPath = normalisePath(rel === "" ? "." : rel);
        } else if (rule.match?.path) {
          continue; // rule needs a path, event has none
        }

        if (!matchesRule(rule, event, relPath)) continue;

        const key = onceKey(config.path, rule, event);
        if (key && ctx.state.seen[key]) continue;

        const result = runActions(rule.actions, {
          path: event.path,
          relpath: relPath,
          command: event.command,
          prompt: event.prompt,
          tool: event.tool,
          event: event.event,
          harness: event.harness,
          session: event.session,
          configDir: config.dir,
          workspace: ctx.workspace,
        });

        outcome.inject.push(...result.inject);
        outcome.logs.push(...result.logs);
        if (result.block && !outcome.block) {
          outcome.block = { reason: result.block.reason, rule: rule.name };
        }
        outcome.fired.push({
          rule: rule.name,
          config: config.path,
          actions: rule.actions.map(actionKind),
        });

        if (key) ctx.state.seen[key] = now().toISOString();
      }
    }
  }

  return outcome;
}
