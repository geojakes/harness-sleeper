#!/bin/sh
# Example of driving sleeper from a shell-based harness that has no native
# hook support, using `sleeper emit`.
#
# Run it from a repo that has a sleeper.yaml (e.g. this repo's root, or
# examples/multi-repo/repo-a).
set -eu

WORKSPACE="${1:-$PWD}"
SESSION="fake-harness-$$"

emit() {
  node "$(dirname "$0")/../dist/src/cli.js" emit "$@" --session "$SESSION" --workspace "$WORKSPACE" --harness generic
}

echo "== session start =="
emit session.start

echo "== agent reads a file =="
result=$(emit file.read --path "$WORKSPACE/sleeper.yaml")
echo "$result"
# A real harness would splice the "inject" strings from $result into the
# agent's context before continuing, and stop if "block" is non-null.

echo "== agent runs a shell command =="
result=$(emit command.run --command "echo hello")
echo "$result"
block=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).block ? "1" : "0")' "$result")
if [ "$block" = "1" ]; then
  echo "blocked, stopping" >&2
  exit 3
fi

echo "== session end =="
emit session.end

echo "== event log for this session =="
node "$(dirname "$0")/../dist/src/cli.js" events --session "$SESSION" --harness generic --workspace "$WORKSPACE"
