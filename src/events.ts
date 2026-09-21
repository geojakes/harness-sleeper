/**
 * Generic, harness-independent event model.
 *
 * Every hook call from a harness (Claude Code, Cursor, ...) is normalised into
 * one or more of these events. Rules in sleeper.yaml are written against this
 * vocabulary, never against harness-specific hook names.
 */

export const EVENT_NAMES = [
  "session.start",
  "session.end",
  "prompt.submit",
  "tool.call",
  "tool.result",
  "file.read",
  "file.read.done",
  "file.write",
  "file.write.done",
  "command.run",
  "command.done",
  "agent.stop",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

/** Which harness produced the event. "generic" is the CLI / any other harness. */
export type HarnessName = "claude" | "cursor" | "generic";

export interface SleeperEvent {
  /** Generic event name. */
  event: EventName;
  /** Harness that produced the event. */
  harness: HarnessName;
  /** Harness session identifier (Claude session_id, Cursor conversation_id, ...). */
  session: string;
  /** Absolute workspace root the harness is operating in. */
  workspace: string;
  /** ISO timestamp. */
  at: string;
  /** Absolute file path, for file.* events. */
  path?: string;
  /** Shell command, for command.* events. */
  command?: string;
  /** User prompt text, for prompt.submit. */
  prompt?: string;
  /** Harness-native tool name, for tool.* and derived events. */
  tool?: string;
  /** Harness-native tool input (opaque). */
  input?: unknown;
  /** Tool output / command output, for *.done and tool.result events. */
  output?: string;
  /** Harness-native hook event name, kept for debugging and logging. */
  native?: string;
}

/** Stages at which a rule fired at "pre" can block the underlying action. */
export const BLOCKABLE_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "prompt.submit",
  "tool.call",
  "file.read",
  "file.write",
  "command.run",
]);
