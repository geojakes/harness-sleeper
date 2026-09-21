/**
 * Claude Code adapter: `sleeper hook claude`.
 *
 * Reads one Claude Code hook JSON payload from stdin, maps it to generic
 * sleeper events, and renders the hook-specific JSON output Claude Code
 * expects back on stdout.
 */

import path from "node:path";
import type { SleeperEvent } from "../events.js";
import type { Outcome } from "../engine.js";
import type { HookAdapter, HookCapabilities, ParsedHook } from "./index.js";

const MAX_OUTPUT_CHARS = 20_000;

export interface ClaudeRawInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function resolvePath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function fileToolPath(cwd: string, toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) return undefined;
  const raw = toolInput.file_path ?? toolInput.notebook_path;
  return resolvePath(cwd, raw);
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function buildEvents(input: ClaudeRawInput, workspace: string, session: string, at: string): SleeperEvent[] {
  const base = { harness: "claude" as const, session, workspace, at };
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;

  switch (input.hook_event_name) {
    case "SessionStart":
      return [{ ...base, event: "session.start", native: "SessionStart" }];

    case "UserPromptSubmit":
      return [{ ...base, event: "prompt.submit", prompt: input.prompt, native: "UserPromptSubmit" }];

    case "PreToolUse": {
      const events: SleeperEvent[] = [
        { ...base, event: "tool.call", tool: input.tool_name, input: toolInput, native: "PreToolUse" },
      ];
      const toolName = input.tool_name;
      if (toolName === "Read") {
        const filePath = fileToolPath(workspace, toolInput);
        if (filePath) events.push({ ...base, event: "file.read", path: filePath, tool: toolName, input: toolInput, native: "PreToolUse" });
      } else if (toolName !== undefined && WRITE_TOOLS.has(toolName)) {
        const filePath = fileToolPath(workspace, toolInput);
        if (filePath) events.push({ ...base, event: "file.write", path: filePath, tool: toolName, input: toolInput, native: "PreToolUse" });
      } else if (toolName === "Bash") {
        const command = typeof toolInput?.command === "string" ? toolInput.command : undefined;
        if (command !== undefined) events.push({ ...base, event: "command.run", command, tool: toolName, input: toolInput, native: "PreToolUse" });
      }
      return events;
    }

    case "PostToolUse": {
      const output = stringifyOutput(input.tool_response);
      const events: SleeperEvent[] = [
        { ...base, event: "tool.result", tool: input.tool_name, input: toolInput, output, native: "PostToolUse" },
      ];
      const toolName = input.tool_name;
      if (toolName === "Read") {
        const filePath = fileToolPath(workspace, toolInput);
        if (filePath) events.push({ ...base, event: "file.read.done", path: filePath, tool: toolName, output, native: "PostToolUse" });
      } else if (toolName !== undefined && WRITE_TOOLS.has(toolName)) {
        const filePath = fileToolPath(workspace, toolInput);
        if (filePath) events.push({ ...base, event: "file.write.done", path: filePath, tool: toolName, output, native: "PostToolUse" });
      } else if (toolName === "Bash") {
        const command = typeof toolInput?.command === "string" ? toolInput.command : undefined;
        if (command !== undefined) events.push({ ...base, event: "command.done", command, tool: toolName, output, native: "PostToolUse" });
      }
      return events;
    }

    case "Stop":
      return [{ ...base, event: "agent.stop", native: "Stop" }];

    case "SessionEnd":
      return [{ ...base, event: "session.end", native: "SessionEnd" }];

    default:
      return [];
  }
}

const CAPABILITIES: Record<string, HookCapabilities> = {
  SessionStart: { inject: true, block: false },
  UserPromptSubmit: { inject: true, block: true },
  PreToolUse: { inject: true, block: true },
  PostToolUse: { inject: true, block: false },
  Stop: { inject: true, block: false },
  SessionEnd: { inject: false, block: false },
};

/** Parse a raw Claude Code hook JSON payload into generic sleeper events. */
export function parseClaude(raw: string, _env: NodeJS.ProcessEnv): ParsedHook<ClaudeRawInput> {
  const input = JSON.parse(raw) as ClaudeRawInput;
  if (typeof input.session_id !== "string" || typeof input.cwd !== "string" || typeof input.hook_event_name !== "string") {
    throw new Error("claude hook payload is missing session_id, cwd or hook_event_name");
  }

  const workspace = path.resolve(input.cwd);
  const session = input.session_id;
  const capabilities = CAPABILITIES[input.hook_event_name];

  if (!capabilities) {
    return {
      events: [],
      native: input,
      capabilities: { inject: false, block: false },
      workspace,
      session,
      harness: "claude",
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
    harness: "claude",
    discardPending: input.hook_event_name === "SessionEnd",
  };
}

function joinInjects(inject: string[]): string {
  return inject.join("\n\n");
}

/** Render sleeper's outcome as the JSON Claude Code expects on stdout for this hook. */
export function renderClaude(outcome: Outcome, parsed: ParsedHook<ClaudeRawInput>): string | null {
  const hookEventName = parsed.native.hook_event_name;

  switch (hookEventName) {
    case "PreToolUse":
    case "PostToolUse": {
      const hookSpecificOutput: Record<string, unknown> = { hookEventName };
      let hasOutput = false;
      if (outcome.inject.length > 0) {
        hookSpecificOutput.additionalContext = joinInjects(outcome.inject);
        hasOutput = true;
      }
      if (hookEventName === "PreToolUse" && outcome.block) {
        hookSpecificOutput.permissionDecision = "deny";
        hookSpecificOutput.permissionDecisionReason = outcome.block.reason;
        hasOutput = true;
      }
      return hasOutput ? JSON.stringify({ hookSpecificOutput }) : null;
    }

    case "UserPromptSubmit": {
      if (outcome.block) {
        return JSON.stringify({ decision: "block", reason: outcome.block.reason });
      }
      if (outcome.inject.length > 0) {
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: joinInjects(outcome.inject) },
        });
      }
      return null;
    }

    case "SessionStart":
    case "Stop": {
      if (outcome.inject.length > 0) {
        return JSON.stringify({
          hookSpecificOutput: { hookEventName, additionalContext: joinInjects(outcome.inject) },
        });
      }
      return null;
    }

    default:
      return null;
  }
}

export const claudeAdapter: HookAdapter<ClaudeRawInput> = {
  parse: parseClaude,
  render: renderClaude,
};
