/**
 * Tiny `{{var}}` template substitution used in action strings.
 *
 * Every action string (inject, block, run, log) may reference the template
 * variables listed in the README. Missing values render as an empty string.
 */

export type TemplateVars = Record<string, string | undefined>;

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/** Replace every `{{name}}` in `input` with `vars[name]`, or "" if unset. */
export function renderTemplate(input: string, vars: TemplateVars): string {
  return input.replace(PLACEHOLDER, (_match, key: string) => vars[key] ?? "");
}
