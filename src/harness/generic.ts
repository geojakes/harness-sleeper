/**
 * Generic adapter: `sleeper emit <event> [flags]`.
 *
 * Lets any shell-based or otherwise non-integrated harness report an event
 * by invoking the CLI directly. Every event can inject and block, since
 * there is no native staging to worry about.
 */

import path from "node:path";
import type { EventName, HarnessName, SleeperEvent } from "../events.js";
import { isEventName } from "../events.js";
import type { Outcome } from "../engine.js";
import type { HookAdapter, ParsedHook } from "./index.js";

export interface GenericRawInput {
  event: string;
  path?: string;
  command?: string;
  prompt?: string;
  tool?: string;
  output?: string;
  session?: string;
  workspace?: string;
  harness?: string;
}

/** Parse the JSON built from `sleeper emit` CLI flags into one generic event. */
export function parseGeneric(raw: string, env: NodeJS.ProcessEnv): ParsedHook<GenericRawInput> {
  const input = JSON.parse(raw) as GenericRawInput;
  if (!isEventName(input.event)) {
    throw new Error(`unknown event "${input.event}"`);
  }

  const workspace = path.resolve(input.workspace ?? env.PWD ?? process.cwd());
  const session = input.session ?? "cli";
  const harness: HarnessName = (input.harness as HarnessName | undefined) ?? "generic";
  const at = new Date().toISOString();

  const eventPath = input.path ? (path.isAbsolute(input.path) ? input.path : path.resolve(workspace, input.path)) : undefined;

  const event: SleeperEvent = {
    event: input.event as EventName,
    harness,
    session,
    workspace,
    at,
    path: eventPath,
    command: input.command,
    prompt: input.prompt,
    tool: input.tool,
    output: input.output,
    native: "emit",
  };

  return {
    events: [event],
    native: input,
    capabilities: { inject: true, block: true },
    workspace,
    session,
    harness,
  };
}

/** Render the outcome as the JSON `sleeper emit` always prints. */
export function renderGeneric(outcome: Outcome, _parsed: ParsedHook<GenericRawInput>): string {
  return JSON.stringify({
    inject: outcome.inject,
    block: outcome.block ? { reason: outcome.block.reason, rule: outcome.block.rule } : null,
    log: outcome.logs,
  });
}

export const genericAdapter: HookAdapter<GenericRawInput> = {
  parse: parseGeneric,
  render: (outcome, parsed) => renderGeneric(outcome, parsed),
};
