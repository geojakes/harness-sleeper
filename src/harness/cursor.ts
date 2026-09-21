/**
 * Cursor adapter: `sleeper hook cursor`.
 *
 * Reads one Cursor hook JSON payload from stdin, maps it to generic sleeper
 * events, and renders the JSON output Cursor expects back on stdout.
 */

import path from "node:path";
import type { SleeperEvent } from "../events.js";
import type { Outcome } from "../engine.js";
import type { HookAdapter, HookCapabilities, ParsedHook } from "./index.js";

const MAX_OUTPUT_CHARS = 20_000;

export interface CursorRawInput {
  conversation_id: string;
  generation_id?: string;
  hook_event_name: string;
  workspace_roots?: string[];
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  attachments?: unknown;
  file_path?: string;
  content?: string;
  edits?: unknown;
  command?: string;
  output?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
}

function stringifyOutput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return truncate(String(value));
  }
}

function resolveWorkspace(input: CursorRawInput, env: NodeJS.ProcessEnv): string {
  const fromRoots = input.workspace_roots?.[0];
  const base = fromRoots ?? input.cwd ?? env.PWD ?? process.cwd();
  return path.resolve(base);
}

function resolvePath(input: CursorRawInput, workspace: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  const base = input.cwd ? path.resolve(input.cwd) : workspace;
  return path.resolve(base, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull a file path out of a generic tool_input, trying the common key names. */
function toolInputPath(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) return undefined;
  const raw = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path;
  return typeof raw === "string" ? raw : undefined;
}

function buildEvents(input: CursorRawInput, workspace: string, session: string, at: string): SleeperEvent[] {
  const base = { harness: "cursor" as const, session, workspace, at };
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;

  switch (input.hook_event_name) {
    case "sessionStart":
      return [{ ...base, event: "session.start", native: "sessionStart" }];

    case "beforeSubmitPrompt":
      return [{ ...base, event: "prompt.submit", prompt: input.prompt, native: "beforeSubmitPrompt" }];

    case "beforeReadFile": {
      const filePath = resolvePath(input, workspace, input.file_path);
      return [{ ...base, event: "file.read", path: filePath, native: "beforeReadFile" }];
    }

    case "afterFileEdit": {
      const filePath = resolvePath(input, workspace, input.file_path);
      return [{ ...base, event: "file.write.done", path: filePath, native: "afterFileEdit" }];
    }

    case "beforeShellExecution":
      return [{ ...base, event: "command.run", command: input.command, native: "beforeShellExecution" }];

    case "afterShellExecution":
      return [{ ...base, event: "command.done", command: input.command, output: stringifyOutput(input.output), native: "afterShellExecution" }];

    case "preToolUse": {
      const events: SleeperEvent[] = [
        { ...base, event: "tool.call", tool: input.tool_name, input: toolInput, native: "preToolUse" },
      ];
      const toolName = input.tool_name ?? "";
      const filePath = resolvePath(input, workspace, toolInputPath(toolInput));
      if (/edit|write/i.test(toolName) && filePath) {
        events.push({ ...base, event: "file.write", path: filePath, tool: toolName, input: toolInput, native: "preToolUse" });
      } else if (/read/i.test(toolName) && filePath) {
        events.push({ ...base, event: "file.read", path: filePath, tool: toolName, input: toolInput, native: "preToolUse" });
      }
      return events;
    }

    case "postToolUse": {
      const output = stringifyOutput(input.tool_output);
      const events: SleeperEvent[] = [
        { ...base, event: "tool.result", tool: input.tool_name, input: toolInput, output, native: "postToolUse" },
      ];
      const toolName = input.tool_name ?? "";
      const filePath = resolvePath(input, workspace, toolInputPath(toolInput));
      if (/edit|write/i.test(toolName) && filePath) {
        events.push({ ...base, event: "file.write.done", path: filePath, tool: toolName, output, native: "postToolUse" });
      } else if (/read/i.test(toolName) && filePath) {
        events.push({ ...base, event: "file.read.done", path: filePath, tool: toolName, output, native: "postToolUse" });
      }
      return events;
    }

    case "stop":
      return [{ ...base, event: "agent.stop", native: "stop" }];

    case "sessionEnd":
      return [{ ...base, event: "session.end", native: "sessionEnd" }];

    default:
      return [];
  }
}

const CAPABILITIES: Record<string, HookCapabilities> = {
  sessionStart: { inject: true, block: false },
  beforeSubmitPrompt: { inject: false, block: true },
  beforeReadFile: { inject: false, block: true },
  afterFileEdit: { inject: false, block: false },
  beforeShellExecution: { inject: false, block: true },
  afterShellExecution: { inject: false, block: false },
  preToolUse: { inject: false, block: true },
  postToolUse: { inject: true, block: false },
  stop: { inject: false, block: false },
  sessionEnd: { inject: false, block: false },
};

/** Parse a raw Cursor hook JSON payload into generic sleeper events. */
export function parseCursor(raw: string, env: NodeJS.ProcessEnv): ParsedHook<CursorRawInput> {
  const input = JSON.parse(raw) as CursorRawInput;
  if (typeof input.conversation_id !== "string" || typeof input.hook_event_name !== "string") {
    throw new Error("cursor hook payload is missing conversation_id or hook_event_name");
  }

  const workspace = resolveWorkspace(input, env);
  const session = input.conversation_id;
  const capabilities = CAPABILITIES[input.hook_event_name];

  if (!capabilities) {
    return {
      events: [],
      native: input,
      capabilities: { inject: false, block: false },
      workspace,
      session,
      harness: "cursor",
      ignored: true,
    };
  }

  const at = new Date().toISOString();
  return {
    events: buildEvents(input, workspace, session, at),
    native: input,
    capabilities,
    workspace,
    session,
    harness: "cursor",
    discardPending: input.hook_event_name === "sessionEnd",
  };
}

/** Render sleeper's outcome as the JSON Cursor expects on stdout for this hook. */
export function renderCursor(outcome: Outcome, parsed: ParsedHook<CursorRawInput>): string | null {
  const hookEventName = parsed.native.hook_event_name;

  switch (hookEventName) {
    case "sessionStart":
    case "postToolUse":
      return outcome.inject.length > 0 ? JSON.stringify({ additional_context: outcome.inject.join("\n\n") }) : null;

    case "beforeSubmitPrompt":
      return outcome.block ? JSON.stringify({ continue: false, user_message: outcome.block.reason }) : null;

    case "beforeReadFile":
      return outcome.block ? JSON.stringify({ permission: "deny", user_message: outcome.block.reason }) : null;

    case "beforeShellExecution":
    case "preToolUse":
      return outcome.block
        ? JSON.stringify({ permission: "deny", user_message: outcome.block.reason, agent_message: outcome.block.reason })
        : null;

    default:
      return null;
  }
}

export const cursorAdapter: HookAdapter<CursorRawInput> = {
  parse: parseCursor,
  render: renderCursor,
};
