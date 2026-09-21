import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, ConfigError } from "../src/config.js";

const VALID = `
version: 1
rules:
  - name: r1
    on: file.read
    match:
      path: "src/**"
    once: path
    actions:
      - inject: "hi {{relpath}}"
`;

test("a valid config loads with the expected shape", () => {
  const config = parseConfig(VALID, "/repo/sleeper.yaml", "/repo");
  assert.equal(config.version, 1);
  assert.equal(config.rules.length, 1);
  assert.equal(config.rules[0]?.name, "r1");
  assert.deepEqual(config.rules[0]?.on, ["file.read"]);
  assert.equal(config.rules[0]?.once, "path");
  assert.deepEqual(config.rules[0]?.match?.path, ["src/**"]);
});

test("unknown event name is rejected with file and rule context", () => {
  const bad = `
version: 1
rules:
  - name: r1
    on: file.frobnicate
    actions:
      - log: "x"
`;
  assert.throws(
    () => parseConfig(bad, "/repo/sleeper.yaml", "/repo"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /\/repo\/sleeper\.yaml/);
      assert.match(err.message, /r1/);
      assert.match(err.message, /file\.frobnicate/);
      return true;
    },
  );
});

test("unknown action key is rejected", () => {
  const bad = `
version: 1
rules:
  - name: r1
    on: file.read
    actions:
      - inject: "hi"
        frobnicate: true
`;
  assert.throws(() => parseConfig(bad, "/repo/sleeper.yaml", "/repo"), ConfigError);
});

test("missing rule name is rejected", () => {
  const bad = `
version: 1
rules:
  - on: file.read
    actions:
      - log: "x"
`;
  assert.throws(
    () => parseConfig(bad, "/repo/sleeper.yaml", "/repo"),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /\/repo\/sleeper\.yaml/);
      assert.match(err.message, /name/);
      return true;
    },
  );
});

test("non-array actions is rejected", () => {
  const bad = `
version: 1
rules:
  - name: r1
    on: file.read
    actions: "not a list"
`;
  assert.throws(() => parseConfig(bad, "/repo/sleeper.yaml", "/repo"), ConfigError);
});

test("bad regex in match is rejected", () => {
  const bad = `
version: 1
rules:
  - name: r1
    on: command.run
    match:
      command: "(unclosed"
    actions:
      - log: "x"
`;
  assert.throws(() => parseConfig(bad, "/repo/sleeper.yaml", "/repo"), ConfigError);
});

test("duplicate rule names within a file are rejected", () => {
  const bad = `
version: 1
rules:
  - name: r1
    on: file.read
    actions:
      - log: "a"
  - name: r1
    on: file.write
    actions:
      - log: "b"
`;
  assert.throws(() => parseConfig(bad, "/repo/sleeper.yaml", "/repo"), ConfigError);
});
