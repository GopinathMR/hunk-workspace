# hunk-workspace — Memory

Operational learnings for this repo. One fact per line.

## Hunk extension API (0.24 / API 31)
- Command contexts have no `review.requestReload()`; only event contexts do. Reload from a command with `ctx.commands.execute("hunk.app.refresh")`.
- File ids renumber across a reload. To land on a file after a reload, remember its path and resolve it in `session_reload` (`changeset.files`).
- `ctx.selection` exposes only the selected file. There's no folder selection from the built-in Files tree.
- Every registered command appears in the Extensions menu. Leaving out `key` gives a menu-only command.
- A key that collides with a built-in is refused with a warning, and the command stays registered.
- Panes are passive views with no focus. A pane cursor lives in module state (`useSyncExternalStore`), driven by row clicks and commands.

## Git gotchas
- `git add -A` in the root repo adds unignored child repos as gitlinks. Pass `:(exclude)<child>` pathspecs (see `stage.ts` `eachFolderRepo`).
- macOS `tmpdir()` is behind a `/var` → `/private/var` symlink, and `git rev-parse --show-toplevel` returns the real path. Compare against `realpathSync(root)`.
- An `index.lock` file in `.git/` is an easy way to make one repo's git write fail in tests.

## Dev environment
- Live check: `tmux new-session -d -x 200 -y 40 "hunk diff --extension <repo>"`, then `send-keys`/`capture-pane`. Under ~200 cols Hunk hides the sidebars. Binding conflicts show as an `ext ... is taken by` toast at the bottom.
- Screenshots: `tmux capture-pane -e -p | freeze --language ansi -o x.png`, then `sips -Z 1800`.
- `ctrl+u`/`ctrl+d` are Hunk's half-page aliases, so they can't be bound by extensions.
