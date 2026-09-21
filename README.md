# harness-sleeper

`sleeper` hooks into AI coding harnesses (Claude Code, Cursor, or anything
else via a small CLI interface), records every event the agent produces into
a per-session log, and evaluates rules from `sleeper.yaml` files found in
the workspace. Rules map events to deterministic actions: inject context,
block an action, run a script, or write a log line.

Motivating example: the first time an agent reads `src/auth/session.ts` in
this repo, inject a note explaining the module's invariants. The workspace
can be a single repo or a folder containing several repos, each with its
own `sleeper.yaml`.

## Install

```sh
npm i -g harness-sleeper
sleeper install claude   # writes hooks into .claude/settings.json
sleeper install cursor   # writes hooks into .cursor/hooks.json
```

Add `--global` to install into `~/.claude/settings.json` or
`~/.cursor/hooks.json` instead of the project-local file. Both commands are
idempotent: running them again replaces sleeper's own entries in place and
leaves every other hook and setting untouched. `sleeper uninstall claude` /
`sleeper uninstall cursor` remove them.

## How it works

1. The harness calls its native hook (e.g. Claude Code's `PreToolUse`) with
   a JSON payload on stdin.
2. sleeper's adapter for that harness turns the payload into one or more
   generic events (`file.read`, `command.run`, ...).
3. sleeper discovers every `sleeper.yaml` relevant to those events and
   evaluates their rules in order (workspace root first, then progressively
   more specific configs).
4. Every rule whose `on`/`match`/`once` conditions are met runs its
   `actions`, collecting text to inject, an optional block, and log lines.
5. The result is translated back into whatever native format that harness's
   hook stage expects, and everything is recorded to the session's event
   log.

Because each hook call is a separate, short-lived process, all state that
needs to survive between calls (what has already fired, queued injects)
lives on disk under the state directory, written atomically.

## Config file

Looked for as `sleeper.yaml`, `.sleeper.yaml`, or `.sleeper/config.yaml`
(first match wins) in each directory sleeper considers.

```yaml
version: 1
rules:
  - name: auth-module-context      # required, unique within the file
    on: file.read                  # a single event or a list
    match:                         # optional; every key present must match
      path: "src/auth/**"          # glob string or list, relative to this file's dir. "!" negates.
      command: "^npm publish"      # regex against the shell command
      prompt: "deploy"             # regex against the prompt text
      tool: "Bash"                 # regex against the harness-native tool name
      harness: claude              # claude | cursor | generic, string or list
    once: path                     # false (default) | true (= path) | path | rule
    actions:
      - inject: "text with {{path}}"
      - block: "reason"
      - run: "./scripts/check.sh {{path}}"
        inject_output: true        # feed stdout back as an injected context string
        timeout: 10                # seconds, default 30
      - log: "message"
```

Config files are validated strictly: unknown event names, unknown match or
action keys, a missing rule `name`, a non-list `actions`, an invalid regex,
or a duplicate rule name all fail with an error naming the file and the
offending rule.

### Events

| Event | Fired by |
|---|---|
| `session.start` | Session/conversation begins |
| `session.end` | Session/conversation ends |
| `prompt.submit` | The user submits a prompt |
| `tool.call` | Any harness-native tool is about to run |
| `tool.result` | Any harness-native tool finished |
| `file.read` | A file is about to be read |
| `file.read.done` | A file read finished |
| `file.write` | A file is about to be written/edited |
| `file.write.done` | A file write/edit finished |
| `command.run` | A shell command is about to run |
| `command.done` | A shell command finished |
| `agent.stop` | The agent finished its turn |

`file.read`, `file.write`, `command.run`, `tool.call` and `prompt.submit`
are the events that can be blocked (see the capability matrix below); the
others are informational.

### Actions

| Action | Effect |
|---|---|
| `inject: "text"` | Add text to the agent's context, if the current stage supports it |
| `block: "reason"` | Deny the tool call / reject the prompt, if the current stage supports it |
| `run: "cmd"` | Run a shell command (cwd = the config file's directory). `inject_output: true` feeds trimmed stdout back as an inject. A non-zero exit or timeout injects nothing and is logged to stderr and the session log instead. |
| `log: "text"` | Write a line to the session log only |

All actions run in the order they're listed. Within one `evaluate()` call,
across every matching rule, the **first** `block` wins, but later rules
still run and contribute their `inject`/`log` output.

### Template variables

Every action string may reference: `{{path}}` (absolute), `{{relpath}}`
(relative to the config file's directory), `{{command}}`, `{{prompt}}`,
`{{tool}}`, `{{event}}`, `{{harness}}`, `{{session}}`, `{{config_dir}}`,
`{{workspace}}`. A variable with no value for the current event renders as
an empty string.

### `once`

- `false` (default): the rule fires every time it matches.
- `once: path` (`once: true` is shorthand for this): fires at most once per
  session, per (config file, rule name, matched absolute path).
- `once: rule`: fires at most once per session, per (config file, rule
  name), regardless of path.

A firing is only recorded once the rule actually runs its actions, so a
rule that never matches never consumes its `once` slot.

## Config discovery in multi-repo workspaces

The workspace root is the absolute directory the harness hands sleeper
(Claude's `cwd`, Cursor's `workspace_roots[0]`, or `--workspace`/`cwd` for
the generic CLI).

- **Events with a path**: sleeper walks from the directory containing the
  path up to (and including) the workspace root, collecting a config from
  every directory that has one, in root-first order. The workspace root's
  config is always included, even if the path is outside it (in which case
  it's the only one that applies).
- **Events without a path** (`session.start`, `prompt.submit`, `agent.stop`,
  ...): the workspace root's config, plus configs in the workspace root's
  direct child directories (skipping hidden directories and
  `node_modules`).
- Each config's rules are scoped to its own directory: for a child repo's
  config, a rule only matches events whose path is inside that repo, and
  `match.path` globs are matched relative to that repo's directory, not the
  workspace root. The workspace root config always applies.

See `examples/multi-repo/` for a worked example with `sleeper check`.

## The pending-injection queue

Not every native hook stage can inject context back into the agent (e.g.
Cursor's `beforeReadFile` can only allow or deny, not inject). When a rule
wants to inject at a stage that can't, the text is queued in the session's
state instead of being dropped. The next stage in that session that *can*
inject flushes the queue first (oldest first), then adds its own injects.

Likewise, if a rule blocks at a stage that can't enforce a block, the block
is downgraded to an inject reading `sleeper: blocked action was not
enforceable at this stage: <reason>` (queued the same way), and the
downgrade is logged to stderr so it's visible when debugging.

At session end, any still-queued injects are discarded rather than queued
forever.

## Harness capability matrix

| Harness | Stage | Can inject | Can block |
|---|---|---|---|
| Claude Code | SessionStart | yes | no |
| Claude Code | UserPromptSubmit | yes | yes |
| Claude Code | PreToolUse | yes | yes |
| Claude Code | PostToolUse | yes | no |
| Claude Code | Stop | yes | no |
| Claude Code | SessionEnd | no | no |
| Cursor | sessionStart | yes | no |
| Cursor | beforeSubmitPrompt | no | yes |
| Cursor | beforeReadFile | no | yes |
| Cursor | afterFileEdit | no | no |
| Cursor | beforeShellExecution | no | yes |
| Cursor | afterShellExecution | no | no |
| Cursor | preToolUse | no | yes |
| Cursor | postToolUse | yes | no |
| Cursor | stop | no | no |
| Cursor | sessionEnd | no | no |
| generic (`sleeper emit`) | every event | yes | yes |

## Generic harnesses: `sleeper emit`

Any harness without a native integration can call the CLI directly:

```sh
sleeper emit file.read --path src/auth/session.ts --session my-session --workspace /path/to/repo
```

It always prints one JSON object:

```json
{ "inject": ["..."], "block": { "reason": "...", "rule": "..." } | null, "log": ["..."] }
```

Flags: `--path`, `--command`, `--prompt`, `--tool`, `--output`, `--session`
(default `cli`), `--workspace` (default cwd), `--harness` (default
`generic`). Exit code is `0` normally, `3` if the outcome blocked, so a
calling script can check `$?`. See `examples/fake-harness.sh` for a full
shell-based harness loop.

## State and logs

State lives at `$SLEEPER_STATE_DIR` if set, otherwise
`<workspace>/.sleeper/state/` (gitignored automatically). Per session:

- `<harness>-<session>.json`: `once` tracking (`seen`) and the pending
  injection queue, written atomically.
- `<harness>-<session>.events.jsonl`: append-only, one JSON object per
  line — `{"type":"event", ...}` for every generic event recorded,
  `{"type":"fired", ...}` after a rule runs, and `{"type":"ignored", ...}`
  for a native hook call sleeper doesn't recognise.

## `sleeper check`

Validates every `sleeper.yaml` discoverable under a directory (default:
cwd), walking subdirectories up to 3 levels deep and skipping
`node_modules`, `.git` and hidden directories. Prints each config's path
and its rules (name, events, `once`), or the validation error and exits 1.

## `sleeper events`

Prints session event logs in a human-readable format by default. With
`--session`/`--harness` it filters to one session; with neither, it prints
every session log under the resolved state directory, newest file first,
separated by a blank line. Each file starts with a header derived from its
name, then one line per record: fixed-width time, event name and tool name
columns, followed by a detail (a workspace-relative path for file events, a
truncated one-line command or prompt, or the native hook name where
relevant). Rule firings and ignored native hooks are called out so they
stand out from ordinary events:

```
== claude session s1
09:14:02  file.read       Read        src/a.ts
09:14:05  command.run     Bash        npm test
09:14:05  >> fired  example-rule  [inject]  sleeper.yaml
```

Pass `--json` to get the previous behaviour back: a `# <filename>` header
followed by the raw JSONL content of each file, unchanged.

## Other commands

- `sleeper init`: writes a starter `sleeper.yaml` in the current directory
  (refuses to overwrite an existing one).
- `sleeper hook claude` / `sleeper hook cursor`: run the native hook
  adapters. Reads one JSON payload from stdin, always exits 0 (a bug in
  sleeper must never break the harness it's hooked into).
- `sleeper --version`, `sleeper --help`.

## Development

```sh
npm run build   # tsc
npm test        # build, then run the node:test suite in dist/test
```
