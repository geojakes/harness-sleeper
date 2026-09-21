/**
 * Config discovery: find every sleeper.yaml relevant to an event or a workspace.
 *
 * A workspace may be a single repo or a folder containing several repos, each
 * with its own config. See the README's "config discovery" section for the
 * exact rules this implements.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, SleeperConfig } from "./config.js";

/** Config file names, in priority order, checked in each candidate directory. */
export const CONFIG_FILENAMES = ["sleeper.yaml", ".sleeper.yaml", path.join(".sleeper", "config.yaml")];

/** Return the first config file found directly in `dir`, or null. */
export function findConfigFile(dir: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // does not exist; try the next name
    }
  }
  return null;
}

function loadIfPresent(dir: string, out: SleeperConfig[], seen: Set<string>): void {
  const file = findConfigFile(dir);
  if (!file || seen.has(file)) return;
  seen.add(file);
  out.push(loadConfig(file, dir));
}

function isInside(parentDir: string, target: string): boolean {
  const rel = path.relative(parentDir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Configs relevant to one event, in rule-evaluation order (workspace root
 * first, then progressively deeper directories).
 *
 * `eventPath` is the event's absolute path, if it has one. Events without a
 * path see the root config plus configs in direct child directories of the
 * workspace root.
 */
export function discoverConfigsForEvent(workspace: string, eventPath?: string): SleeperConfig[] {
  const root = path.resolve(workspace);
  const out: SleeperConfig[] = [];
  const seen = new Set<string>();

  if (eventPath) {
    const target = path.resolve(eventPath);
    if (isInside(root, target)) {
      let dir: string;
      try {
        dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
      } catch {
        dir = path.dirname(target);
      }
      const chain: string[] = [];
      for (;;) {
        chain.push(dir);
        if (path.resolve(dir) === root) break;
        const parent = path.dirname(dir);
        if (parent === dir) break; // filesystem root safety net
        dir = parent;
      }
      chain.reverse(); // root first, target directory last
      for (const d of chain) loadIfPresent(d, out, seen);
    }
    // Outside the workspace (or the walk above didn't reach it): root still applies.
    loadIfPresent(root, out, seen);
    return out;
  }

  loadIfPresent(root, out, seen);
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const childDirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
  for (const name of childDirs) loadIfPresent(path.join(root, name), out, seen);

  return out;
}

/**
 * Every config discoverable under `workspace`, walking all subdirectories up
 * to `maxDepth`, skipping node_modules, .git and hidden directories. Used by
 * `sleeper check`.
 */
export function discoverAllConfigs(workspace: string, maxDepth = 3): SleeperConfig[] {
  const root = path.resolve(workspace);
  const out: SleeperConfig[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    loadIfPresent(dir, out, seen);
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort();
    for (const name of subdirs) walk(path.join(dir, name), depth + 1);
  }

  walk(root, 0);
  return out;
}
