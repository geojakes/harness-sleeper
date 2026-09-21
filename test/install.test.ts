import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installClaude, uninstallClaude, installCursor, uninstallCursor, claudeSettingsPath, cursorHooksPath } from "../src/install.js";

function mkCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sleeper-install-"));
}

test("installing claude hooks twice yields exactly one sleeper entry per event and keeps unrelated hooks", () => {
  const cwd = mkCwd();
  const target = claudeSettingsPath({ cwd });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "some-other-tool run-lint" }] }],
      },
      otherSetting: true,
    }),
  );

  installClaude({ cwd });
  installClaude({ cwd });

  const settings = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(settings.otherSetting, true);

  // Unrelated hook preserved.
  const preToolGroups = settings.hooks.PreToolUse;
  const unrelated = preToolGroups.filter((g: any) => g.matcher === "Bash");
  assert.equal(unrelated.length, 1);
  assert.equal(unrelated[0].hooks[0].command, "some-other-tool run-lint");

  // Exactly one sleeper entry per event, not duplicated by the second install.
  for (const evt of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
    const groups = settings.hooks[evt];
    const sleeperGroups = groups.filter((g: any) =>
      (g.hooks ?? []).some((h: any) => typeof h.command === "string" && h.command.endsWith(" hook claude")),
    );
    assert.equal(sleeperGroups.length, 1, `expected exactly one sleeper group for ${evt}`);
    assert.equal(sleeperGroups[0].hooks.length, 1);
    assert.equal(sleeperGroups[0].hooks[0].command, "sleeper hook claude");
  }
});

test("uninstalling claude hooks removes sleeper entries and leaves unrelated hooks and empty-key cleanup", () => {
  const cwd = mkCwd();
  installClaude({ cwd });
  uninstallClaude({ cwd });

  const target = claudeSettingsPath({ cwd });
  const settings = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(settings.hooks, undefined);
});

test("installing cursor hooks twice yields exactly one sleeper entry per event and keeps unrelated hooks", () => {
  const cwd = mkCwd();
  const target = cursorHooksPath({ cwd });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      hooks: {
        stop: [{ command: "other-tool run-check" }],
      },
    }),
  );

  installCursor({ cwd });
  installCursor({ cwd });

  const settings = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(settings.version, 1);

  const stopEntries = settings.hooks.stop;
  const unrelated = stopEntries.filter((h: any) => h.command === "other-tool run-check");
  assert.equal(unrelated.length, 1);
  const sleeperEntries = stopEntries.filter((h: any) => h.command === "sleeper hook cursor");
  assert.equal(sleeperEntries.length, 1);

  for (const evt of [
    "sessionStart",
    "beforeSubmitPrompt",
    "beforeReadFile",
    "afterFileEdit",
    "beforeShellExecution",
    "afterShellExecution",
    "preToolUse",
    "postToolUse",
    "stop",
    "sessionEnd",
  ]) {
    const entries = settings.hooks[evt];
    const sleeper = entries.filter((h: any) => h.command === "sleeper hook cursor");
    assert.equal(sleeper.length, 1, `expected exactly one sleeper entry for ${evt}`);
  }
});

test("uninstalling cursor hooks removes sleeper entries", () => {
  const cwd = mkCwd();
  installCursor({ cwd });
  uninstallCursor({ cwd });

  const target = cursorHooksPath({ cwd });
  const settings = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(settings.hooks, undefined);
});
