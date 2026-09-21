import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEventLine, formatLogHeader } from "../src/format.js";

test("formatLogHeader derives harness and session from the file name", () => {
  assert.equal(formatLogHeader("claude-s1.events.jsonl", "/ws"), "== claude session s1");
});

test("file event renders a path relative to the workspace", () => {
  const record = {
    type: "event",
    event: "file.read",
    harness: "claude",
    session: "s1",
    workspace: "/ws",
    at: "2024-01-01T00:00:00.000Z",
    path: "/ws/src/a.ts",
    tool: "Read",
  };
  const line = formatEventLine(record, "/ws");
  assert.match(line, /src\/a\.ts/);
  assert.doesNotMatch(line, /\/ws\/src\/a\.ts/);
});

test("command event is truncated to 100 chars and has no newline", () => {
  const longCommand = "echo\nline-two " + "x".repeat(200);
  const record = {
    type: "event",
    event: "command.run",
    harness: "claude",
    session: "s1",
    workspace: "/ws",
    at: "2024-01-01T00:00:00.000Z",
    command: longCommand,
    tool: "Bash",
  };
  const line = formatEventLine(record, "/ws");
  assert.doesNotMatch(line, /\n/);
  assert.ok(line.endsWith("..."));
  const detail = line.slice(line.indexOf("Bash") + "Bash".length).trimStart();
  // 100 chars of content plus the ellipsis.
  assert.equal(detail.length, 103);
});

test("fired record names the rule and the actions", () => {
  const record = {
    type: "fired",
    at: "2024-01-01T00:00:00.000Z",
    rule: "example-rule",
    config: "/ws/sleeper.yaml",
    actions: ["inject", "block"],
  };
  const line = formatEventLine(record, "/ws");
  assert.match(line, />> fired/);
  assert.match(line, /example-rule/);
  assert.match(line, /\[inject,block\]/);
});

test("ignored record is reported plainly", () => {
  const record = { type: "ignored", at: "2024-01-01T00:00:00.000Z" };
  const line = formatEventLine(record, "/ws");
  assert.match(line, /ignored native hook/);
});

test("an unparseable line is returned verbatim", () => {
  const raw = "not valid json {{{";
  assert.equal(formatEventLine(raw, "/ws"), raw);
});
