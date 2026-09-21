import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch, globMatchAny } from "../src/glob.js";

test("** matches nested paths under a directory", () => {
  assert.equal(globMatch("src/auth/**", "src/auth/a.ts"), true);
  assert.equal(globMatch("src/auth/**", "src/auth/x/y.ts"), true);
  assert.equal(globMatch("src/auth/**", "src/authx/a.ts"), false);
});

test("basename-only pattern matches regardless of directory", () => {
  assert.equal(globMatch("*.md", "docs/g.md"), true);
  assert.equal(globMatch("*.md", "g.md"), true);
  assert.equal(globMatch("*.md", "docs/g.txt"), false);
});

test("{a,b} alternation", () => {
  assert.equal(globMatch("{a,b}.txt", "a.txt"), true);
  assert.equal(globMatch("{a,b}.txt", "b.txt"), true);
  assert.equal(globMatch("{a,b}.txt", "c.txt"), false);
});

test("globMatchAny applies negation in order", () => {
  assert.equal(globMatchAny(["src/**", "!src/generated/**"], "src/a.ts"), true);
  assert.equal(globMatchAny(["src/**", "!src/generated/**"], "src/generated/a.ts"), false);
  assert.equal(globMatchAny(["!src/generated/**", "src/**"], "src/generated/a.ts"), true);
});
