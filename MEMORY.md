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
- Homebrew Hunk is 0.22 but the extension needs 0.24+, so local live runs aren't possible. Rely on `bun test` against real temp repos plus `tsc`.
