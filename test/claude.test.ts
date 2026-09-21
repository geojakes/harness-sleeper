import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../src/harness/index.js";
import { claudeAdapter } from "../src/harness/claude.js";

function mkWorkspace(configYaml: string): { workspace: string; env: NodeJS.ProcessEnv } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-claude-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sleeper.yaml"), configYaml);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-claude-state-"));
  return { workspace, env: { ...process.env, SLEEPER_STATE_DIR: stateDir } };
}

test("PreToolUse Read: injects context on the first read, nothing on the second", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules:
  - name: read-once
    on: file.read
    once: path
    actions:
      - inject: "note about {{relpath}}"
`);
  const filePath = path.join(workspace, "src", "a.ts");
  const payload = JSON.stringify({
    session_id: "s1",
    cwd: workspace,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: filePath },
  });

  const first = runHook(claudeAdapter, payload, env);
  assert.ok(first);
  const parsedFirst = JSON.parse(first!);
  assert.equal(parsedFirst.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(parsedFirst.hookSpecificOutput.additionalContext, /note about src\/a\.ts/);

  const second = runHook(claudeAdapter, payload, env);
  assert.equal(second, null);
});

test("PreToolUse Bash with a block rule denies the tool call", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules:
  - name: block-publish
    on: command.run
    match:
      command: "npm publish"
    actions:
      - block: "no publishing from an agent"
`);
  const payload = JSON.stringify({
    session_id: "s1",
    cwd: workspace,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm publish" },
  });

  const out = runHook(claudeAdapter, payload, env);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /no publishing/);
});

test("UserPromptSubmit with a block rule returns decision:block", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules:
  - name: block-deploy-word
    on: prompt.submit
    match:
      prompt: "deploy"
    actions:
      - block: "deploys need a human"
`);
  const payload = JSON.stringify({
    session_id: "s1",
    cwd: workspace,
    hook_event_name: "UserPromptSubmit",
    prompt: "please deploy this to prod",
  });

  const out = runHook(claudeAdapter, payload, env);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /deploys need a human/);
});

test("SessionStart with a matching rule returns additionalContext", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules:
  - name: greet
    on: session.start
    actions:
      - inject: "welcome to {{workspace}}"
`);
  const payload = JSON.stringify({
    session_id: "s1",
    cwd: workspace,
    hook_event_name: "SessionStart",
    source: "startup",
  });

  const out = runHook(claudeAdapter, payload, env);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /welcome to/);
});

test("an unrecognised hook_event_name is ignored without error", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules: []
`);
  const payload = JSON.stringify({
    session_id: "s1",
    cwd: workspace,
    hook_event_name: "SomeFutureHook",
  });
  const out = runHook(claudeAdapter, payload, env);
  assert.equal(out, null);
});
