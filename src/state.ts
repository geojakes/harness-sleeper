/**
 * Per-session state: what has already fired (for `once`), queued pending
 * injects, and the append-only event log. See the README for the on-disk
 * layout.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { HarnessName } from "./events.js";

export interface PendingInject {
  text: string;
  queuedAt: string;
  rule: string;
}

export interface SessionState {
  version: 1;
  harness: HarnessName;
  session: string;
  workspace: string;
  startedAt: string;
  /** Keyed by "<configPath>::<rule>::<path or *>", value is the ISO time it fired. */
  seen: Record<string, string>;
  pending: PendingInject[];
}

/** Where session state lives: $SLEEPER_STATE_DIR, or <workspace>/.sleeper/state. */
export function resolveStateDir(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SLEEPER_STATE_DIR;
  if (override) return override;
  return path.join(workspace, ".sleeper", "state");
}

/** Create the state dir if missing, and make sure its contents are gitignored. */
export function ensureStateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n");
  }
}

/** Sanitise a harness session id into a safe file name fragment. */
export function sanitiseSessionId(session: string): string {
  const cleaned = session.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "session";
}

function baseName(harness: HarnessName, session: string): string {
  return `${harness}-${sanitiseSessionId(session)}`;
}

export function statePath(dir: string, harness: HarnessName, session: string): string {
  return path.join(dir, `${baseName(harness, session)}.json`);
}

export function eventsLogPath(dir: string, harness: HarnessName, session: string): string {
  return path.join(dir, `${baseName(harness, session)}.events.jsonl`);
}

/** Load session state from disk, or create a fresh one if absent/corrupt. */
export function loadState(dir: string, harness: HarnessName, session: string, workspace: string): SessionState {
  const file = statePath(dir, harness, session);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      version: 1,
      harness,
      session,
      workspace,
      startedAt: parsed.startedAt ?? new Date().toISOString(),
      seen: parsed.seen ?? {},
      pending: parsed.pending ?? [],
    };
  } catch {
    return {
      version: 1,
      harness,
      session,
      workspace,
      startedAt: new Date().toISOString(),
      seen: {},
      pending: [],
    };
  }
}

/** Write session state atomically: write a temp file, then rename over the target. */
export function saveState(dir: string, state: SessionState): void {
  const file = statePath(dir, state.harness, state.session);
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Append one JSON value as a line to a jsonl file, creating it if needed. */
export function appendJsonLine(file: string, value: unknown): void {
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}
