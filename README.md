# hunk-workspace

A [Hunk](https://hunk.dev) extension for seeing diffs in a **workspace that holds
multiple git repos as sub-folders** (for example `~/github`, or any folder of
cloned repos). One `hunk diff` from the workspace root reviews every changed repo
in a single stream, and a **Repos** sidebar lists the repos that have changes.

```text
┌ Files ─────────────┬ Repos (2) ─────────────┬ Review ──────────────────────────┐
│ CLAUDE.md          │▸(workspace)            │ CLAUDE.md               +3 -0    │
│ my-app/            │   docs/api · 4f +31 -0 │ @@ -26,6 +26,7 @@ ...            │
│   .agents/...      │ my-app                 │                                  │
│                    │   main · 3f +191 -0    │                                  │
└────────────────────┴────────────────────────┴──────────────────────────────────┘
```

## What it does

- **`ws` VCS backend.** It takes over only when the directory you launch Hunk from
  has **two or more** child folders containing `.git`. Both `.git` directories and
  worktree `.git` files count. In any ordinary repo the bundled Git backend still
  runs, including inside one of the child repos.
- **Diffs.** The workspace root repo (if it is one) and each child repo are diffed
  in parallel. Child paths are prefixed with `<repo>/`, so:
  - the built-in Files tree groups files by repo
  - opening a file in your editor and in-review edits work, because every path is
    relative to the workspace root
  - full-file context expansion and syntax highlighting read each file from its
    own repo
- **What is reviewed:**
  - `hunk diff`: unstaged and untracked changes
  - `hunk diff --staged`: staged changes
  - `hunk diff <repo>/<path>`: pathspecs are routed to the repo they name
  - `--exclude-untracked` is honored
  - `--watch` watches every repo's worktree and git metadata
- **Repos pane** (left, open by default). Each row shows the repo name, branch, file
  count and +/- lines. Click a row to jump to that repo's first file. The row that
  holds the selected file is highlighted.
- **Commands.** Remap them under `[keybindings]` using these ids:

  | Key | Command id                      | Action                                   |
  | --- | ------------------------------- | ---------------------------------------- |
  | `W` | `hunk-workspace.toggle-repos`   | Toggle the Repos pane                    |
  | `)` | `hunk-workspace.next-repo`      | Jump to the next changed repo            |
  | `(` | `hunk-workspace.prev-repo`      | Jump to the previous changed repo        |
  | `O` | `hunk-workspace.only-repo`      | Show only the selected file's repo / all |

  While the review is scoped with `O`, clicking another repo in the pane clears the
  scope and jumps there.

## Requirements

- Hunk **0.24.0-beta.1** or newer (extension API 31): `hunk --version`
- `git` 2.31+ on `PATH`
- `bun`, only to run the tests

## Install

Pick one of the three options below.

### Option A: managed install (recommended)

```bash
hunk extension install GopinathMR/hunk-workspace
```

Pin a release with `hunk extension install GopinathMR/hunk-workspace@v0.1.0`.

Hunk asks for confirmation, then fetches the repo into
`~/.config/hunk/extensions/installed/hunk-workspace` and loads it in every session.
Manage it with:

```bash
hunk extension list
hunk extension update hunk-workspace   # pull the latest version
hunk extension remove hunk-workspace
```

### Option B: load straight from the checkout (best while developing)

Edits take effect on the next `hunk` launch, with no update step. Add the path to
your user config, `~/.config/hunk/config.toml`:

```toml
[extensions]
paths = ["/Users/<you>/github/hunk-workspace"]
```

### Option C: one run only

```bash
hunk diff --extension ~/github/hunk-workspace
```

## If your config pins `vcs`

A `vcs = "git"` line in `~/.config/hunk/config.toml` forces the Git backend for
`hunk diff`, so plain `hunk diff` in a workspace root shows only the root repo and
a `hunk-workspace inactive` warning. No config change is needed: run **`hunk ws`**
instead. It takes the same options as `hunk diff` and selects this backend
explicitly, which outranks the config pin.

## Use

```bash
cd ~/github/my-workspace
hunk diff                       # every repo's working-tree changes
hunk diff --staged              # every repo's staged changes
hunk diff -- my-app/            # one repo only

# Same, whatever your config's `vcs` says:
hunk ws
hunk ws --staged
hunk ws -- my-app/
```

The review title reads `Working tree changes · N repos` when the extension is
active.

## Limits

- **No revision ranges.** `hunk diff main`, `hunk show` and `hunk log` have no
  meaning across independent repos and stop with an explanation. `cd` into one
  repo to use them there with the built-in Git backend.
- **Pane order.** Hunk places its built-in Files pane before extension panes, so
  Repos sits to the right of Files. Press `s` to hide Files and leave only Repos.
- **Child repos only.** Only direct children are scanned; nested grandchildren and
  git submodules are not.
- **Watch blind spot.** Under `--watch`, editing a file that is already untracked
  does not trigger a reload. Press `r` to refresh.
- **No large-file skipping.** Unlike bundled Git, this backend does not skip huge
  tracked diffs. Whole-file reads stop at 4 MiB.
- **`--color-moved` is ignored.**

## Develop

```bash
bun install
bun test           # unit + temp-repo integration tests
bun run typecheck
```

Source: `src/workspace.ts` (backend), `src/RepoPane.tsx` (pane), `src/index.tsx`
(registration).
