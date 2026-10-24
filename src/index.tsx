/**
 * hunk-workspace: review a multi-repo workspace as one Hunk session.
 *
 * Registers the `ws` VCS backend (wins over Git only when the launch directory has
 * two or more child git repos), the left `repos` pane, and repo navigation commands.
 */
import { dirname } from "node:path";
import type { ExtensionCommandContext, HunkExtensionAPI } from "hunkdiff/extension";
import { activeScope, groupFilesByRepo, repoScope, RepoPane } from "./RepoPane";
import { listStaged, stageFile, stageFolder, unstageFile, unstageFolder } from "./stage";
import { moveCursor, StagedPane, stagedStore } from "./StagedPane";
import {
  detectWorkspace,
  getRepoSummaries,
  loadWorkspace,
  ROOT_REPO_LABEL,
  wasStagedReview,
  wasWorkspaceLoaded,
  workspaceSignature,
  workspaceWatchPlan,
} from "./workspace";

/** Jump to the first visible file of the next (`step = 1`) or previous (`-1`) changed repo. */
function stepRepo(ctx: ExtensionCommandContext, step: 1 | -1) {
  const summaries = getRepoSummaries();
  const groups = groupFilesByRepo(ctx.selection.files, summaries);
  const order = summaries.map((s) => s.name).filter((name) => groups.has(name));
  if (order.length === 0) return;

  const current = ctx.selection.file
    ? order.findIndex((name) => groups.get(name)?.some((f) => f.id === ctx.selection.file?.id))
    : -1;
  const next = order[(current + step + order.length) % order.length] ?? null;
  const target = groups.get(next)?.[0];
  if (target) ctx.navigation.selectFile(target.id);
}

/** Show only the selected file's repo, or show every repo again. */
function toggleRepoScope(ctx: ExtensionCommandContext) {
  const generation = ctx.review.snapshot()?.generation ?? null;
  if (activeScope(generation)) {
    repoScope.current = null;
    ctx.review.clearPresentationScope();
    return;
  }

  const file = ctx.selection.file;
  if (!file || !generation) return;

  const groups = groupFilesByRepo(ctx.selection.files, getRepoSummaries());
  const repo = [...groups.entries()].find(([, files]) => files.some((f) => f.id === file.id))?.[0];
  const repoFiles = repo === undefined ? [] : (groups.get(repo) ?? []);
  const ok = ctx.review.setPresentationScope({
    generation,
    files: repoFiles.map((f) => ({ fileId: f.id, hunkIndexes: (f.hunks ?? []).map((h) => h.index) })),
  });
  if (ok && repo !== undefined) repoScope.current = { generation, repo };
}

/** File to select once the reload after a stage/unstage lands; ids renumber across reloads. */
let pendingSelectPath: string | null = null;

/** git's stderr when present, else the error message. */
function gitError(error: unknown) {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}

/** Reload the Staged pane's rows from git. */
async function refreshStaged(cwd: string) {
  if (wasWorkspaceLoaded()) stagedStore.set({ rows: await listStaged(cwd) });
}

/** Unstage the Staged pane's cursor row, then reload. */
async function unstageCursorRow(ctx: ExtensionCommandContext, cursor: number) {
  const row = stagedStore.get().rows[cursor];
  if (!row) return;
  try {
    await unstageFile(ctx.cwd, row);
  } catch (error) {
    ctx.notify(gitError(error), "error");
    return;
  }
  await ctx.commands.execute("hunk.app.refresh");
}

/** Stage or unstage the selected file, then reload and land on its neighbor. */
async function stageSelected(ctx: ExtensionCommandContext, unstage: boolean) {
  if (!wasWorkspaceLoaded()) return;
  const file = ctx.selection.file;
  if (!file) {
    ctx.notify(`Select a file to ${unstage ? "unstage" : "stage"}`, "warning");
    return;
  }

  try {
    await (unstage ? unstageFile : stageFile)(ctx.cwd, file);
  } catch (error) {
    ctx.notify(gitError(error), "error");
    return;
  }

  // The file leaves this view, so land on the next one (or the previous if it was last).
  const files = ctx.selection.files;
  const index = files.findIndex((f) => f.id === file.id);
  pendingSelectPath = (files[index + 1] ?? files[index - 1])?.path ?? null;
  await ctx.commands.execute("hunk.app.refresh");
}

/** Stage or unstage everything under the selected file's folder, after a confirm. */
async function stageSelectedFolder(ctx: ExtensionCommandContext, unstage: boolean) {
  if (!wasWorkspaceLoaded()) return;
  const file = ctx.selection.file;
  if (!file) {
    ctx.notify(`Select a file to ${unstage ? "unstage" : "stage"} its folder`, "warning");
    return;
  }

  const dir = dirname(file.path);
  const folder = dir === "." ? "" : dir;
  const under = (path: string) => folder === "" || path.startsWith(`${folder}/`);
  // Unstaged files are what the review shows; staged ones are what the pane lists.
  const count = unstage
    ? stagedStore.get().rows.filter((row) => under(row.path)).length
    : ctx.selection.files.filter((f) => under(f.path)).length;
  const verb = unstage ? "unstage" : "stage";
  if (count === 0) {
    ctx.notify(`Nothing to ${verb}`, "warning");
    return;
  }

  const label = folder || "the workspace root";
  const confirmed = await ctx.dialogs.confirm({
    title: `${unstage ? "Unstage" : "Stage"} ${count} file${count === 1 ? "" : "s"} under ${label}?`,
    confirmLabel: verb,
  });
  if (!confirmed) return;

  const failed = await (unstage ? unstageFolder : stageFolder)(ctx.cwd, folder);
  if (failed.length > 0) {
    const repos = failed.map((repo) => repo || ROOT_REPO_LABEL).join(", ");
    ctx.notify(`git ${unstage ? "reset" : "add"} failed in: ${repos}`, "error");
  }
  await ctx.commands.execute("hunk.app.refresh");
}

export default function hunkWorkspace(hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter({
    id: "ws",
    name: "Multi-repo workspace",
    // Above bundled Git (0) so a workspace root that is itself a git repo reviews every child.
    detectionPriority: 10,
    detect: detectWorkspace,
    operations: {
      "working-tree-diff": {
        load: loadWorkspace,
        watchSignature: workspaceSignature,
        watchPlan: workspaceWatchPlan,
      },
    },
  });

  // `hunk ws [diff flags]`: the CLI `--vcs` flag outranks any `vcs = "git"` config pin.
  hunk.registerCliCommand(
    {
      name: "ws",
      summary: "Review every changed repo in this workspace (ignores a `vcs` config pin)",
      usage: "[diff options] [-- <repo>/<path>...]",
    },
    (args) => ({ kind: "delegate", argv: ["diff", "--vcs", "ws", ...args] }),
  );

  // A `vcs = "git"` pin in Hunk config silently bypasses this backend; say so instead.
  hunk.on("startup", ({ cwd }, ctx) => {
    void refreshStaged(cwd);
    if (!wasWorkspaceLoaded() && detectWorkspace(cwd)) {
      ctx.notify(
        "hunk-workspace inactive: Hunk config pins another VCS. Run `hunk ws` here to review every repo.",
        "warning",
      );
    }
  });

  hunk.registerPane({
    id: "repos",
    title: "Repos",
    placement: "left",
    width: { preferred: 28, min: 18, max: 48 },
    defaultOpen: true,
    // Only meaningful when the `ws` backend loaded this review.
    available: () => getRepoSummaries().length > 0,
    component: RepoPane,
  });

  hunk.registerCommand({ id: "toggle-repos", title: "Toggle Repos pane", key: "W" }, (ctx) =>
    ctx.panes.toggle("repos"),
  );
  hunk.registerCommand({ id: "next-repo", title: "Next changed repo", key: ")" }, (ctx) =>
    stepRepo(ctx, 1),
  );
  hunk.registerCommand({ id: "prev-repo", title: "Previous changed repo", key: "(" }, (ctx) =>
    stepRepo(ctx, -1),
  );
  hunk.registerCommand(
    { id: "only-repo", title: "Show only this repo / show all repos", key: "O" },
    toggleRepoScope,
  );

  hunk.registerPane({
    id: "staged",
    title: "Staged",
    placement: "right",
    width: { preferred: 34, min: 22, max: 60 },
    defaultOpen: false,
    available: wasWorkspaceLoaded,
    component: StagedPane,
  });

  hunk.registerCommand({ id: "toggle-staged", title: "Toggle Staged pane", key: "S" }, (ctx) => {
    ctx.panes.toggle("staged");
    void refreshStaged(ctx.cwd);
  });
  hunk.registerCommand({ id: "staged-up", title: "Staged pane: previous file", key: "ctrl+u" }, () =>
    moveCursor(-1),
  );
  hunk.registerCommand({ id: "staged-down", title: "Staged pane: next file", key: "ctrl+d" }, () =>
    moveCursor(1),
  );

  // `x` unstages the Staged pane's cursor row when one is set; otherwise it stages the
  // selected file in the working-tree review and unstages it in the `--staged` review.
  hunk.registerCommand({ id: "toggle-stage", title: "Stage/unstage selected file", key: "x" }, (ctx) => {
    const { cursor } = stagedStore.get();
    if (cursor !== null && ctx.panes.isVisible("staged")) return unstageCursorRow(ctx, cursor);
    return stageSelected(ctx, wasStagedReview());
  });
  hunk.registerCommand({ id: "stage-file", title: "Stage file" }, (ctx) => stageSelected(ctx, false));
  hunk.registerCommand({ id: "unstage-file", title: "Unstage file" }, (ctx) =>
    stageSelected(ctx, true),
  );
  hunk.registerCommand({ id: "stage-folder", title: "Stage folder" }, (ctx) =>
    stageSelectedFolder(ctx, false),
  );
  hunk.registerCommand({ id: "unstage-folder", title: "Unstage folder" }, (ctx) =>
    stageSelectedFolder(ctx, true),
  );

  // Main-view navigation hands `x` back to the review.
  hunk.on("selection_changed", () => stagedStore.set({ cursor: null }));

  hunk.on("session_reload", ({ changeset }, ctx) => {
    void refreshStaged(ctx.cwd);
    if (pendingSelectPath === null) return;
    const target = changeset.files.find((f) => f.path === pendingSelectPath);
    pendingSelectPath = null;
    if (target) ctx.navigation.selectFile(target.id);
  });
}
