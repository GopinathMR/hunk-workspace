/**
 * Stage and unstage workspace files in the git repo that owns each one.
 *
 * Paths come in workspace-relative (as the review shows them). The owning repo is
 * the nearest enclosing git repo, found by git's own walk-up from the file's folder,
 * so nested repos and the workspace root repo resolve the same way as child repos.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { git, within } from "./workspace";

/** The repo that owns a workspace path, and the path relative to that repo. */
export interface Owner {
  repoDir: string;
  relPath: string;
}

/** A file as the review reports it; `previousPath` is set for renames. */
export interface StageTarget {
  path: string;
  previousPath?: string;
}

/** Find the repo that owns `wsPath`, or null when no repo inside the workspace does. */
export async function resolveOwner(root: string, wsPath: string): Promise<Owner | null> {
  const realRoot = realpathSync(root);
  const target = join(realRoot, wsPath);
  // A deleted file's folder may be gone too; start from the nearest folder that exists.
  let dir = dirname(target);
  while (!existsSync(dir) && within(realRoot, dir)) dir = dirname(dir);
  if (!within(realRoot, dir)) return null;

  let repoDir: string;
  try {
    repoDir = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  // A repo above the workspace root is not ours to stage into.
  if (!within(realRoot, repoDir)) return null;
  return { repoDir, relPath: relative(repoDir, target) };
}

/** Resolve the target's repo and its repo-relative paths (both sides for a rename). */
async function locate(root: string, file: StageTarget) {
  const owner = await resolveOwner(root, file.path);
  if (!owner) throw new Error(`Not in a git repo: ${file.path}`);
  const paths = [owner.relPath];
  if (file.previousPath) {
    paths.push(relative(owner.repoDir, join(realpathSync(root), file.previousPath)));
  }
  return { repoDir: owner.repoDir, paths };
}

/** Stage one file; `-A` stages deletions, and both rename paths together keep the rename. */
export async function stageFile(root: string, file: StageTarget): Promise<void> {
  const { repoDir, paths } = await locate(root, file);
  await git(repoDir, ["add", "-A", "--", ...paths]);
}

/** Unstage one file, leaving its working-tree content untouched. */
export async function unstageFile(root: string, file: StageTarget): Promise<void> {
  const { repoDir, paths } = await locate(root, file);
  await git(repoDir, ["reset", "-q", "--", ...paths]);
}
