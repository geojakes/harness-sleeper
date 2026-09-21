import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../src/engine.js";
import type { SessionState } from "../src/state.js";
import type { SleeperEvent } from "../src/events.js";

function mkWorkspace(configYaml: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-engine-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sleeper.yaml"), configYaml);
  return workspace;
}

function freshState(workspace: string): SessionState {
  return {
    version: 1,
    harness: "claude",
    session: "s1",
    workspace,
    startedAt: new Date().toISOString(),
    seen: {},
    pending: [],
  };
}

function readEvent(workspace: string, filePath: string): SleeperEvent {
  return {
    event: "file.read",
    harness: "claude",
    session: "s1",
    workspace,
    at: new Date().toISOString(),
    path: filePath,
  };
}

test("once: path fires on first read of a path, not on the second, but fires for a different path", () => {
  const workspace = mkWorkspace(`
version: 1
rules:
  - name: once-path
    on: file.read
    once: path
    actions:
      - inject: "seen {{relpath}}"
`);
  const state = freshState(workspace);
  const fileA = path.join(workspace, "src", "a.ts");
  const fileB = path.join(workspace, "src", "b.ts");

  const first = evaluate([readEvent(workspace, fileA)], { workspace, state });
  assert.deepEqual(first.inject, ["seen src/a.ts"]);

  const second = evaluate([readEvent(workspace, fileA)], { workspace, state });
  assert.deepEqual(second.inject, []);

  const third = evaluate([readEvent(workspace, fileB)], { workspace, state });
  assert.deepEqual(third.inject, ["seen src/b.ts"]);
});

test("once: rule fires only once total, regardless of path", () => {
  const workspace = mkWorkspace(`
version: 1
rules:
  - name: once-rule
    on: file.read
    once: rule
    actions:
      - inject: "hi"
`);
  const state = freshState(workspace);
  const fileA = path.join(workspace, "src", "a.ts");
  const fileB = path.join(workspace, "src", "b.ts");

  const first = evaluate([readEvent(workspace, fileA)], { workspace, state });
  assert.deepEqual(first.inject, ["hi"]);

  const second = evaluate([readEvent(workspace, fileB)], { workspace, state });
  assert.deepEqual(second.inject, []);
});

test("templating substitutes {{path}} and {{relpath}}", () => {
  const workspace = mkWorkspace(`
version: 1
rules:
  - name: templated
    on: file.read
    actions:
      - inject: "abs={{path}} rel={{relpath}}"
`);
  const state = freshState(workspace);
  const file = path.join(workspace, "src", "a.ts");
  const outcome = evaluate([readEvent(workspace, file)], { workspace, state });
  assert.deepEqual(outcome.inject, [`abs=${file} rel=src/a.ts`]);
});

test("a run action with inject_output injects the command's stdout", () => {
  const workspace = mkWorkspace(`
version: 1
rules:
  - name: run-rule
    on: file.read
    actions:
      - run: "echo hi {{relpath}}"
        inject_output: true
`);
  const state = freshState(workspace);
  const file = path.join(workspace, "src", "a.ts");
  const outcome = evaluate([readEvent(workspace, file)], { workspace, state });
  assert.deepEqual(outcome.inject, ["hi src/a.ts"]);
});

test("first block wins but later rules still contribute injects and logs", () => {
  const workspace = mkWorkspace(`
version: 1
rules:
  - name: blocker
    on: file.read
    actions:
      - block: "no"
  - name: logger
    on: file.read
    actions:
      - inject: "still runs"
      - log: "still logged"
`);
  const state = freshState(workspace);
  const file = path.join(workspace, "src", "a.ts");
  const outcome = evaluate([readEvent(workspace, file)], { workspace, state });
  assert.deepEqual(outcome.block, { reason: "no", rule: "blocker" });
  assert.deepEqual(outcome.inject, ["still runs"]);
  assert.deepEqual(outcome.logs, ["still logged"]);
});
