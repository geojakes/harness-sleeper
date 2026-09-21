/**
 * Shared pipeline every harness adapter runs through: parse the native hook
 * call into generic events, evaluate the rule engine, apply the
 * pending-injection queue for stages that cannot inject or block, then let
 * the adapter render its native output.
 */

import type { HarnessName, SleeperEvent } from "../events.js";
import type { Outcome } from "../engine.js";
import { evaluate } from "../engine.js";
import {
  appendJsonLine,
  ensureStateDir,
  eventsLogPath,
  loadState,
  resolveStateDir,
  saveState,
  type PendingInject,
} from "../state.js";

/** What the current native hook stage is able to do. */
export interface HookCapabilities {
  inject: boolean;
  block: boolean;
}

/** The result of turning one native hook call into sleeper's generic model. */
export interface ParsedHook<TNative = unknown> {
  events: SleeperEvent[];
  native: TNative;
  capabilities: HookCapabilities;
  workspace: string;
  session: string;
  harness: HarnessName;
  /** True for an unrecognised native hook: logged as "ignored", nothing else happens. */
  ignored?: boolean;
  /** True when the session has ended: pending injects are discarded, not queued. */
  discardPending?: boolean;
}

export interface HookAdapter<TNative = unknown> {
  parse(raw: string, env: NodeJS.ProcessEnv): ParsedHook<TNative>;
  render(outcome: Outcome, parsed: ParsedHook<TNative>): string | null;
}

function downgradeUnblockable(outcome: Outcome, capabilities: HookCapabilities): { inject: string[]; block: Outcome["block"] } {
  const inject = [...outcome.inject];
  let block = outcome.block;
  if (block && !capabilities.block) {
    const msg = `sleeper: blocked action was not enforceable at this stage: ${block.reason}`;
    process.stderr.write(msg + "\n");
    inject.push(msg);
    block = null;
  }
  return { inject, block };
}

function applyPendingQueue(outcome: Outcome, pending: PendingInject[], capabilities: HookCapabilities): { outcome: Outcome; pending: PendingInject[] } {
  const { inject: newInjects, block } = downgradeUnblockable(outcome, capabilities);

  if (capabilities.inject) {
    const flushed = pending.map((p) => p.text);
    return {
      outcome: { inject: [...flushed, ...newInjects], block, logs: outcome.logs, fired: outcome.fired },
      pending: [],
    };
  }

  const queuedAt = new Date().toISOString();
  const nextPending = [...pending, ...newInjects.map((text) => ({ text, queuedAt, rule: "" }))];
  return {
    outcome: { inject: [], block, logs: outcome.logs, fired: outcome.fired },
    pending: nextPending,
  };
}

/** Run one native hook call through parse -> evaluate -> render, persisting state as it goes. */
export function runHook<TNative>(adapter: HookAdapter<TNative>, rawInput: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = adapter.parse(rawInput, env);
  const stateDir = resolveStateDir(parsed.workspace, env);
  ensureStateDir(stateDir);
  const state = loadState(stateDir, parsed.harness, parsed.session, parsed.workspace);
  const logFile = eventsLogPath(stateDir, parsed.harness, parsed.session);

  if (parsed.ignored) {
    appendJsonLine(logFile, { type: "ignored", at: new Date().toISOString() });
    saveState(stateDir, state);
    return null;
  }

  for (const event of parsed.events) {
    appendJsonLine(logFile, { type: "event", ...event });
  }

  const rawOutcome = evaluate(parsed.events, { workspace: parsed.workspace, state });

  for (const fired of rawOutcome.fired) {
    appendJsonLine(logFile, { type: "fired", at: new Date().toISOString(), ...fired });
  }

  let finalOutcome: Outcome;
  if (parsed.discardPending) {
    const { block } = downgradeUnblockable(rawOutcome, parsed.capabilities);
    state.pending = [];
    finalOutcome = { inject: [], block, logs: rawOutcome.logs, fired: rawOutcome.fired };
  } else {
    const { outcome, pending } = applyPendingQueue(rawOutcome, state.pending, parsed.capabilities);
    state.pending = pending;
    finalOutcome = outcome;
  }

  const output = adapter.render(finalOutcome, parsed);
  saveState(stateDir, state);
  return output;
}
