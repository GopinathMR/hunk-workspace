/**
 * Stage and unstage workspace files in the git repo that owns each one.
 *
 * Paths come in workspace-relative (as the review shows them). The owning repo is
 * the nearest enclosing git repo, found by git's own walk-up from the file's folder,
 * so nested repos and the workspace root repo resolve the same way as child repos.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { git, listChildRepos, within } from "./workspace";

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

/**
 * Repos staged into this session that the workspace scan doesn't list (nested repos),
 * so the Staged pane can still show and unstage them.
 */
const stagedRepos = new Set<string>();

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
  stagedRepos.add(repoDir);
}

/** Unstage one file, leaving its working-tree content untouched. */
export async function unstageFile(root: string, file: StageTarget): Promise<void> {
  const { repoDir, paths } = await locate(root, file);
  await git(repoDir, ["reset", "-q", "--", ...paths]);
}

/** One staged file as the Staged pane lists it; paths are workspace-relative. */
export interface StagedRow {
  /** Repo folder relative to the workspace root, `""` for the root repo. */
  repo: string;
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
}

/**
 * Parse `git diff --numstat -z --find-renames`.
 *
 * Ported from hunk-git-lite (MIT). A plain entry is one token, `added\tdeleted\tpath`.
 * A rename leaves the path field empty and follows with two tokens: old path, new path.
 * Binary files report `-` counts, read here as 0.
 */
export function parseNumstat(
  output: string,
): Array<{ path: string; previousPath?: string; additions: number; deletions: number }> {
  const tokens = output.split("\0").filter(Boolean);
  const entries: Array<{ path: string; previousPath?: string; additions: number; deletions: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const [added = "", deleted = "", inline = ""] = tokens[i]!.split("\t");
    const counts = { additions: Number(added) || 0, deletions: Number(deleted) || 0 };
    if (inline === "") {
      entries.push({ ...counts, previousPath: tokens[i + 1], path: tokens[i + 2] ?? "" });
      i += 2;
    } else {
      entries.push({ ...counts, path: inline });
    }
  }
  return entries;
}

/** Every staged file in the root repo, each child repo, and any nested repo staged into. */
export async function listStaged(root: string): Promise<StagedRow[]> {
  const realRoot = realpathSync(root);
  const dirs = new Set([
    ...(existsSync(join(realRoot, ".git")) ? [realRoot] : []),
    ...listChildRepos(realRoot).map((name) => join(realRoot, name)),
    ...[...stagedRepos].filter((dir) => within(realRoot, dir)),
  ]);

  const perRepo = await Promise.all(
    [...dirs].sort().map(async (dir) => {
      const repo = relative(realRoot, dir);
      const prefix = repo ? `${repo}/` : "";
      // The root repo must not report child repos as gitlink changes.
      const ignore = repo ? [] : ["--ignore-submodules=all"];
      const out = await git(dir, ["diff", "--cached", "--numstat", "-z", "--find-renames", ...ignore]).catch(
        () => "",
      );
      return parseNumstat(out).map((entry) => ({
        repo,
        path: `${prefix}${entry.path}`,
        previousPath: entry.previousPath === undefined ? undefined : `${prefix}${entry.previousPath}`,
        additions: entry.additions,
        deletions: entry.deletions,
      }));
    }),
  );
  return perRepo.flat();
}
