import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverConfigsForEvent } from "../src/discover.js";

function mkTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-discover-"));
}

const ROOT_CONFIG = `
version: 1
rules:
  - name: root-rule
    on: file.read
    actions:
      - log: "root"
`;

const CHILD_CONFIG = `
version: 1
rules:
  - name: child-rule
    on: file.read
    match:
      path: "src/**"
    actions:
      - log: "child"
`;

function setupMultiRepoWorkspace(): string {
  const workspace = mkTempWorkspace();
  fs.writeFileSync(path.join(workspace, "sleeper.yaml"), ROOT_CONFIG);
  fs.mkdirSync(path.join(workspace, "repo-a", "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "repo-a", "sleeper.yaml"), CHILD_CONFIG);
  fs.mkdirSync(path.join(workspace, "repo-b", "src"), { recursive: true });
  return workspace;
}

test("a path event under the child repo sees both root and child configs, root first", () => {
  const workspace = setupMultiRepoWorkspace();
  const filePath = path.join(workspace, "repo-a", "src", "index.ts");
  const configs = discoverConfigsForEvent(workspace, filePath);
  assert.equal(configs.length, 2);
  assert.equal(configs[0]?.dir, workspace);
  assert.equal(configs[1]?.dir, path.join(workspace, "repo-a"));
});

test("child rule's path glob is matched relative to the child config's directory", () => {
  const workspace = setupMultiRepoWorkspace();
  const filePath = path.join(workspace, "repo-a", "src", "index.ts");
  const configs = discoverConfigsForEvent(workspace, filePath);
  const childConfig = configs.find((c) => c.dir === path.join(workspace, "repo-a"));
  assert.ok(childConfig);
  assert.equal(childConfig?.rules[0]?.match?.path?.[0], "src/**");
});

test("a path event in a sibling repo does not see the other child's rules", () => {
  const workspace = setupMultiRepoWorkspace();
  const filePath = path.join(workspace, "repo-b", "src", "index.ts");
  const configs = discoverConfigsForEvent(workspace, filePath);
  assert.equal(configs.length, 1);
  assert.equal(configs[0]?.dir, workspace);
});

test("a path outside the workspace only sees the root config", () => {
  const workspace = setupMultiRepoWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-outside-"));
  const filePath = path.join(outside, "somefile.ts");
  const configs = discoverConfigsForEvent(workspace, filePath);
  assert.equal(configs.length, 1);
  assert.equal(configs[0]?.dir, workspace);
});

test("events without a path see the root config plus direct child configs", () => {
  const workspace = setupMultiRepoWorkspace();
  const configs = discoverConfigsForEvent(workspace, undefined);
  const dirs = configs.map((c) => c.dir).sort();
  assert.deepEqual(dirs, [workspace, path.join(workspace, "repo-a")].sort());
});
