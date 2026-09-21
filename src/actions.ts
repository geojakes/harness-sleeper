/**
 * Executes a rule's action list (inject / block / run / log) against a
 * template context, producing the strings the engine collects.
 */

import { spawnSync } from "node:child_process";
import type { RuleAction } from "./config.js";
import { renderTemplate } from "./template.js";

export interface ActionContext {
  path?: string;
  relpath?: string;
  command?: string;
  prompt?: string;
  tool?: string;
  event: string;
  harness: string;
  session: string;
  configDir: string;
  workspace: string;
}

export interface ActionResult {
  inject: string[];
  block: { reason: string } | null;
  logs: string[];
}

function templateVars(ctx: ActionContext): Record<string, string | undefined> {
  return {
    path: ctx.path,
    relpath: ctx.relpath,
    command: ctx.command,
    prompt: ctx.prompt,
    tool: ctx.tool,
    event: ctx.event,
    harness: ctx.harness,
    session: ctx.session,
    config_dir: ctx.configDir,
    workspace: ctx.workspace,
  };
}

function runShellAction(action: Extract<RuleAction, { run: string }>, vars: Record<string, string | undefined>, ctx: ActionContext, result: ActionResult): void {
  const command = renderTemplate(action.run, vars);
  const timeoutMs = (action.timeout ?? 30) * 1000;
  const res = spawnSync(command, {
    shell: true,
    cwd: ctx.configDir,
    timeout: timeoutMs,
    encoding: "utf8",
  });

  if (res.error) {
    const msg = `sleeper: run action failed (${command}): ${res.error.message}`;
    process.stderr.write(msg + "\n");
    result.logs.push(msg);
    return;
  }
  if (res.status !== 0) {
    const detail = res.signal ? `killed by ${res.signal}` : `exit code ${res.status}`;
    const msg = `sleeper: run action failed (${command}): ${detail}`;
    process.stderr.write(msg + "\n");
    result.logs.push(msg);
    return;
  }
  if (action.inject_output) {
    result.inject.push((res.stdout ?? "").trim());
  }
}

/** Run a rule's actions in order, returning what it wants to inject/block/log. */
export function runActions(actions: RuleAction[], ctx: ActionContext): ActionResult {
  const result: ActionResult = { inject: [], block: null, logs: [] };
  const vars = templateVars(ctx);

  for (const action of actions) {
    if ("inject" in action) {
      result.inject.push(renderTemplate(action.inject, vars));
    } else if ("block" in action) {
      if (!result.block) result.block = { reason: renderTemplate(action.block, vars) };
    } else if ("log" in action) {
      result.logs.push(renderTemplate(action.log, vars));
    } else if ("run" in action) {
      runShellAction(action, vars, ctx, result);
    }
  }

  return result;
}

/** Short label for a rule action, used in "fired" log lines. */
export function actionKind(action: RuleAction): "inject" | "block" | "run" | "log" {
  if ("inject" in action) return "inject";
  if ("block" in action) return "block";
  if ("run" in action) return "run";
  return "log";
}
