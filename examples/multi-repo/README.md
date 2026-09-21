# Example: a workspace with several repos

This directory is a workspace containing two repos, `repo-a` and `repo-b`,
plus a `sleeper.yaml` at the workspace root:

```
multi-repo/
  sleeper.yaml          <- workspace root config
  repo-a/
    sleeper.yaml         <- scoped to repo-a only
    src/auth/...
    scripts/check.sh
  repo-b/
    sleeper.yaml         <- scoped to repo-b only
    src/generated/...
```

If you point a harness's `cwd` (or `--workspace`) at `multi-repo/`, sleeper
treats `multi-repo/` as the workspace root:

- The root `sleeper.yaml` applies to every event anywhere in the workspace,
  including events inside `repo-a` and `repo-b`.
- `repo-a/sleeper.yaml` only applies to events whose path is inside `repo-a/`.
  Its `match.path` globs (e.g. `src/auth/**`) are matched relative to
  `repo-a/`, not to the workspace root.
- `repo-b/sleeper.yaml` only applies to events inside `repo-b/`. It never
  sees `repo-a`'s rules and vice versa.
- A `file.read` event for `repo-a/src/auth/login.ts` is evaluated against
  the root config's rules first, then `repo-a`'s rules.

Try it:

```sh
cd examples/multi-repo
node ../../dist/src/cli.js check
```

This prints every config found (root, repo-a, repo-b) and its rules, which
is a good way to sanity check a multi-repo layout before wiring up a real
harness.

To see the scoping in action, emit a read event for a file in repo-a and
then one for the equivalent path in repo-b: only repo-a's rule fires for
the first, and neither of repo-a's rules fire for the second.

```sh
node ../../dist/src/cli.js emit file.read --workspace "$PWD" --path repo-a/src/auth/login.ts
node ../../dist/src/cli.js emit file.read --workspace "$PWD" --path repo-b/src/auth/login.ts
```
