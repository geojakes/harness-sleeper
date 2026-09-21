/**
 * Human-readable rendering of `sleeper events` log lines. The raw records are
 * the JSONL shapes written by src/harness/index.ts via src/state.ts:
 * `{"type":"event", ...SleeperEvent}`, `{"type":"fired", ...FiredRule}`, and
 * `{"type":"ignored", at}`.
 */

import path from "node:path";

const MAX_DETAIL_LEN = 100;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function localTime(at: unknown): string {
  const d = typeof at === "string" ? new Date(at) : new Date(NaN);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Collapse to one line and truncate to MAX_DETAIL_LEN chars with an ellipsis. */
function singleLineTruncate(text: string): string {
  const oneLine = text.replace(/\r?\n/g, " ");
  if (oneLine.length <= MAX_DETAIL_LEN) return oneLine;
  return oneLine.slice(0, MAX_DETAIL_LEN) + "...";
}

function relativePath(filePath: string, workspace: string): string {
  const rel = path.relative(workspace, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return rel;
}

/** Derive `== claude session s1` from a `<harness>-<session>.events.jsonl` file name. */
export function formatLogHeader(fileName: string, _workspace: string): string {
  const base = fileName.replace(/\.events\.jsonl$/, "");
  const sep = base.indexOf("-");
  const harness = sep === -1 ? base : base.slice(0, sep);
  const session = sep === -1 ? "" : base.slice(sep + 1);
  return `== ${harness} session ${session}`;
}

function detailFor(record: Record<string, unknown>, workspace: string): string {
  const event = typeof record.event === "string" ? record.event : "";
  if (event.startsWith("file.")) {
    return typeof record.path === "string" ? relativePath(record.path, workspace) : "";
  }
  if (event.startsWith("command.")) {
    return typeof record.command === "string" ? singleLineTruncate(record.command) : "";
  }
  if (event === "prompt.submit") {
    return typeof record.prompt === "string" ? singleLineTruncate(record.prompt) : "";
  }
  if (event.startsWith("session.") || event === "agent.stop") {
    return typeof record.native === "string" ? record.native : "";
  }
  return "";
}

function formatEventRecord(record: Record<string, unknown>, workspace: string): string {
  const time = localTime(record.at);
  const event = typeof record.event === "string" ? record.event : "";
  const tool = typeof record.tool === "string" ? record.tool : "";
  const detail = detailFor(record, workspace);
  return `${time}  ${pad(event, 16)}${pad(tool, 12)}${detail}`.trimEnd();
}

function formatFiredRecord(record: Record<string, unknown>, workspace: string): string {
  const time = localTime(record.at);
  const rule = typeof record.rule === "string" ? record.rule : "";
  const actions = Array.isArray(record.actions) ? record.actions.map((a) => String(a)).join(",") : "";
  const config = typeof record.config === "string" ? relativePath(record.config, workspace) : "";
  return `${time}  >> fired  ${rule}  [${actions}]  ${config}`;
}

function formatIgnoredRecord(record: Record<string, unknown>): string {
  const time = localTime(record.at);
  return `${time}  (ignored native hook)`;
}

/** Render one parsed log record (or an unparseable raw line) as one human-readable line. */
export function formatEventLine(record: unknown, workspace: string): string {
  if (record === null || typeof record !== "object") {
    return typeof record === "string" ? record : JSON.stringify(record);
  }
  const rec = record as Record<string, unknown>;
  switch (rec.type) {
    case "event":
      return formatEventRecord(rec, workspace);
    case "fired":
      return formatFiredRecord(rec, workspace);
    case "ignored":
      return formatIgnoredRecord(rec);
    default:
      return JSON.stringify(record);
  }
}
