import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../src/harness/index.js";
import { cursorAdapter } from "../src/harness/cursor.js";

function mkWorkspace(configYaml: string): { workspace: string; env: NodeJS.ProcessEnv } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-cursor-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sleeper.yaml"), configYaml);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-cursor-state-"));
  return { workspace, env: { ...process.env, SLEEPER_STATE_DIR: stateDir } };
}

test("beforeReadFile queues its inject; the following postToolUse flushes it", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules:
  - name: read-note
    on: file.read
    once: path
    actions:
      - inject: "note about {{relpath}}"
`);
  const filePath = path.join(workspace, "src", "a.ts");

  const readPayload = JSON.stringify({
    conversation_id: "c1",
    generation_id: "g1",
    hook_event_name: "beforeReadFile",
    workspace_roots: [workspace],
    cwd: workspace,
    file_path: filePath,
  });
  const readOut = runHook(cursorAdapter, readPayload, env);
  assert.equal(readOut, null);

  const postPayload = JSON.stringify({
    conversation_id: "c1",
    generation_id: "g1",
    hook_event_name: "postToolUse",
    workspace_roots: [workspace],
    cwd: workspace,
    tool_name: "SomeOtherTool",
    tool_input: {},
    tool_output: "done",
  });
  const postOut = runHook(cursorAdapter, postPayload, env);
  assert.ok(postOut);
  const parsed = JSON.parse(postOut!);
  assert.match(parsed.additional_context, /note about src\/a\.ts/);
});

test("beforeShellExecution with a block rule denies with permission", () => {
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
    conversation_id: "c1",
    generation_id: "g1",
    hook_event_name: "beforeShellExecution",
    workspace_roots: [workspace],
    cwd: workspace,
    command: "npm publish",
  });
  const out = runHook(cursorAdapter, payload, env);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  assert.equal(parsed.permission, "deny");
  assert.match(parsed.user_message, /no publishing/);
});

test("sessionStart injects directly since that stage can inject", () => {
  const { workspace, env } = mkWorkspace(`
version: 1
rules:
  - name: greet
    on: session.start
    actions:
      - inject: "welcome"
`);
  const payload = JSON.stringify({
    conversation_id: "c1",
    generation_id: "g1",
    hook_event_name: "sessionStart",
    workspace_roots: [workspace],
  });
  const out = runHook(cursorAdapter, payload, env);
  assert.ok(out);
  const parsed = JSON.parse(out!);
  assert.match(parsed.additional_context, /welcome/);
});
