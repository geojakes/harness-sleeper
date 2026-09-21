/**
 * Minimal glob matcher, so the tool has no dependency beyond `yaml`.
 *
 * Supported syntax (matched against forward-slash separated relative paths):
 *   **      any number of path segments (including none)
 *   *       any characters within one segment
 *   ?       one character within one segment
 *   {a,b}   alternatives
 *   [abc]   character class (passed through to RegExp)
 *
 * A pattern with no slash matches against the basename only, like .gitignore,
 * so `*.md` matches `docs/guide.md`.
 */

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**" — consume a following slash so "a/**/b" matches "a/b".
        i += 2;
        if (pattern[i] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
        i += 1;
        continue;
      }
      const alternatives = pattern
        .slice(i + 1, close)
        .split(",")
        .map((alt) => globToRegExp(alt).source.slice(1, -1));
      re += "(?:" + alternatives.join("|") + ")";
      i = close + 1;
      continue;
    }
    if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        re += "\\[";
        i += 1;
        continue;
      }
      re += pattern.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (/[.+^$()|\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp("^" + re + "$");
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re;
}

/** Normalise a path for matching: forward slashes, no leading "./". */
export function normalisePath(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** Match a relative path against one glob pattern. */
export function globMatch(pattern: string, relPath: string): boolean {
  const path = normalisePath(relPath);
  const pat = normalisePath(pattern);
  if (!pat.includes("/")) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return compiled(pat).test(base) || compiled(pat).test(path);
  }
  return compiled(pat).test(path);
}

/** Match against any of a list of patterns. Patterns starting with "!" negate. */
export function globMatchAny(patterns: readonly string[], relPath: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (globMatch(pattern.slice(1), relPath)) matched = false;
    } else if (globMatch(pattern, relPath)) {
      matched = true;
    }
  }
  return matched;
}
