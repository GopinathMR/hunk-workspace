/**
 * Loads one Hunk review from every changed git repo in a multi-repo workspace.
 *
 * A workspace is a directory whose direct children are separate git repos (the
 * root may itself be a repo that ignores them).
 * Each child repo's diff is prefixed with `<repo>/`, so every path in the review
 * stays relative to the workspace root: the built-in files tree groups by repo,
 * editor opens and document writes resolve, and the Repos pane can group by the
 * first path segment. Root-repo paths stay unprefixed.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HunkExtensionUserError } from "hunkdiff/extension";
import type {
  ExtensionVcsDetection,
  ExtensionVcsDiffInput,
  ExtensionVcsDirectoryTreeWatchTarget,
  ExtensionVcsFileSourceReader,
  ExtensionVcsLoadContext,
  ExtensionVcsPatchResult,
  ExtensionVcsWatchPlan,
} from "hunkdiff/extension";

const execFileAsync = promisify(execFile);

/** Label the Repos pane uses for files that belong to the workspace root repo. */
export const ROOT_REPO_LABEL = "(workspace)";

/** Largest whole-file source read for context expansion and highlighting. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Pin diff headers to `a/`/`b/` and ASCII-quoted paths regardless of user git config. */
const GIT_NORMALIZE_ARGS = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
];

/** One changed repo as the Repos pane lists it. */
export interface RepoSummary {
  /** Child folder name, or `null` for the workspace root repo. */
  name: string | null;
  branch: string;
  fileCount: number;
}

let latestSummaries: readonly RepoSummary[] = [];
let workspaceLoaded = false;
let stagedReview = false;

/** Return whether the `ws` backend produced the current review (false when Git was used). */
export function wasWorkspaceLoaded(): boolean {
  return workspaceLoaded;
}

/** Return whether the current review is `--staged` (so `x` unstages instead of stages). */
export function wasStagedReview(): boolean {
  return stagedReview;
}

/** Return the changed repos from the most recent load, in review order. */
export function getRepoSummaries(): readonly RepoSummary[] {
  return latestSummaries;
}

/** List direct child folders that hold a git checkout (`.git` dir or worktree file). */
export function listChildRepos(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  return entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, ".git"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

/** Recognize a workspace only at the launch directory, so a plain repo keeps Git review. */
export function detectWorkspace(cwd: string): ExtensionVcsDetection | null {
  const root = resolve(cwd);
  return listChildRepos(root).length >= 2 ? { id: "ws", repoRoot: root } : null;
}

/** Insert `prefix` after a git path's opening quote, or at its start when unquoted. */
function prefixGitPath(path: string, prefix: string) {
  return path.startsWith('"') ? `"${prefix}${path.slice(1)}` : `${prefix}${path}`;
}

/**
 * Prefix rename/copy header paths, which `--src-prefix`/`--dst-prefix` leave bare.
 *
 * Header lines never collide with hunk body lines: body lines start with ' ', '+', '-' or '\'.
 */
export function prefixRenameHeaders(patch: string, prefix: string): string {
  if (!prefix) return patch;
  return patch.replace(
    /^((?:rename|copy) (?:from|to) )(.+)$/gm,
    (_line, head: string, path: string) => `${head}${prefixGitPath(path, prefix)}`,
  );
}

/** Split a workspace-relative path into its owning repo and the repo-relative rest. */
export function locatePath(path: string, childRepos: ReadonlySet<string>) {
  const slash = path.indexOf("/");
  const head = slash === -1 ? "" : path.slice(0, slash);
  return childRepos.has(head)
    ? { repo: head as string | null, rest: path.slice(slash + 1) }
    : { repo: null, rest: path };
}

/**
 * Route workspace-relative pathspecs to the repo each one names.
 *
 * Returns `null` when no pathspecs were given (every repo is reviewed in full).
 * Otherwise only repos that received a pathspec appear in the map.
 */
export function routePathspecs(
  pathspecs: readonly string[] | undefined,
  childRepos: ReadonlySet<string>,
): Map<string | null, string[]> | null {
  if (!pathspecs || pathspecs.length === 0) return null;

  const routed = new Map<string | null, string[]>();
  for (const spec of pathspecs) {
    const bare = spec.replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (childRepos.has(bare)) {
      routed.set(bare, [...(routed.get(bare) ?? []), "."]);
      continue;
    }
    const { repo, rest } = locatePath(bare, childRepos);
    routed.set(repo, [...(routed.get(repo) ?? []), rest]);
  }
  return routed;
}

/** Count `diff --git` file sections in a patch. */
export function countPatchFiles(patch: string): number {
  return patch.match(/^diff --git /gm)?.length ?? 0;
}

/** Run git in one repo and return stdout, honoring cancellation. */
export async function git(dir: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", dir, "--no-optional-locks", ...GIT_NORMALIZE_ARGS, ...args],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, signal },
  );
  return stdout;
}

/** Fail clearly for review kinds that have no meaning across independent repos. */
function rejectRanges(input: ExtensionVcsDiffInput) {
  if (input.range || input.rangeEndpoints) {
    throw new HunkExtensionUserError(
      "hunk-workspace reviews working-tree and staged changes only; revision ranges differ per repo.",
      {
        suggestions: [
          "Run `hunk diff` or `hunk diff --staged` from the workspace root.",
          "cd into one repo to review a range there with the built-in Git backend.",
        ],
      },
    );
  }
}

interface RepoDiff {
  summary: RepoSummary;
  patch: string;
  untracked: string[];
}

/** Collect one repo's prefixed patch, untracked paths and branch. */
async function loadRepo(
  root: string,
  name: string | null,
  input: ExtensionVcsDiffInput,
  pathspecs: string[] | undefined,
  signal?: AbortSignal,
): Promise<RepoDiff | null> {
  const dir = name ? join(root, name) : root;
  const prefix = name ? `${name}/` : "";
  const specArgs = pathspecs ? ["--", ...pathspecs] : [];

  const diffArgs = [
    "diff",
    "--no-ext-diff",
    "--find-renames",
    "--no-color",
    `--src-prefix=a/${prefix}`,
    `--dst-prefix=b/${prefix}`,
    // The root repo must not report child repos as gitlink changes.
    ...(name ? [] : ["--ignore-submodules=all"]),
    ...(input.staged ? ["--staged"] : []),
    ...specArgs,
  ];

  const wantUntracked = !input.staged && !input.options.excludeUntracked;
  const [patch, untrackedRaw] = await Promise.all([
    git(dir, diffArgs, signal),
    wantUntracked
      ? git(dir, ["ls-files", "--others", "--exclude-standard", "-z", ...specArgs], signal)
      : Promise.resolve(""),
  ]);

  const untracked = untrackedRaw
    .split("\0")
    .filter(Boolean)
    // A nested repo shows up as `dir/`; child repos get their own section.
    .filter((path) => !path.endsWith("/"))
    .map((path) => `${prefix}${path}`);

  const fileCount = countPatchFiles(patch) + untracked.length;
  if (fileCount === 0) return null;

  const branch =
    (await git(dir, ["branch", "--show-current"], signal).catch(() => "")).trim() ||
    (await git(dir, ["rev-parse", "--short", "HEAD"], signal).catch(() => "")).trim() ||
    "?";

  return {
    summary: { name, branch, fileCount },
    patch: prefixRenameHeaders(patch, prefix),
    untracked,
  };
}

/** Build a reader that resolves each side from the repo that owns the path. */
function createSourceReader(
  root: string,
  childRepos: ReadonlySet<string>,
  staged: boolean,
): ExtensionVcsFileSourceReader {
  const show = async (repo: string | null, spec: string) => {
    try {
      return await git(repo ? join(root, repo) : root, ["show", spec]);
    } catch {
      return null;
    }
  };

  const limit = (text: string | null) =>
    text !== null && Buffer.byteLength(text) > MAX_SOURCE_BYTES
      ? { kind: "too-large" as const, maxBytes: MAX_SOURCE_BYTES }
      : text;

  return async ({ path, previousPath, changeType, isUntracked, side }) => {
    if (side === "old") {
      if (isUntracked || changeType === "new") return null;
      const { repo, rest } = locatePath(previousPath ?? path, childRepos);
      // Working-tree review compares against the index; staged review against HEAD.
      return limit(await show(repo, staged ? `HEAD:${rest}` : `:${rest}`));
    }

    if (changeType === "deleted") return null;
    if (staged) {
      const { repo, rest } = locatePath(path, childRepos);
      return limit(await show(repo, `:${rest}`));
    }

    try {
      const full = join(root, path);
      if (statSync(full).size > MAX_SOURCE_BYTES) {
        return { kind: "too-large", maxBytes: MAX_SOURCE_BYTES };
      }
      return await readFile(full, "utf8");
    } catch {
      return null;
    }
  };
}

/** Load all repo diffs in parallel and keep them in root-then-alphabetical order. */
async function collectWorkspace(input: ExtensionVcsDiffInput, context: ExtensionVcsLoadContext) {
  rejectRanges(input);

  const root = resolve(context.cwd);
  const children = listChildRepos(root);
  const childRepos = new Set(children);
  const routed = routePathspecs(input.pathspecs, childRepos);
  const rootIsRepo = existsSync(join(root, ".git"));

  const targets: (string | null)[] = [...(rootIsRepo ? [null] : []), ...children].filter(
    (name) => !routed || routed.has(name),
  );

  const results = await Promise.all(
    targets.map((name) =>
      loadRepo(root, name, input, routed?.get(name), context.signal),
    ),
  );
  const repos = results.filter((repo): repo is RepoDiff => repo !== null);
  return { root, childRepos, repos };
}

/** `working-tree-diff` load: one combined patch for every changed repo. */
export async function loadWorkspace(
  input: ExtensionVcsDiffInput,
  context: ExtensionVcsLoadContext,
): Promise<ExtensionVcsPatchResult> {
  const { root, childRepos, repos } = await collectWorkspace(input, context);
  latestSummaries = repos.map((repo) => repo.summary);
  workspaceLoaded = true;
  stagedReview = input.staged;

  const patchText = repos
    .map((repo) => repo.patch)
    .filter(Boolean)
    .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
    .join("");

  return {
    repoRoot: root,
    sourceLabel: root,
    title: `${input.staged ? "Staged" : "Working tree"} changes · ${repos.length} repo${repos.length === 1 ? "" : "s"}`,
    patchText,
    untrackedPaths: repos.flatMap((repo) => repo.untracked),
    readFileSource: createSourceReader(root, childRepos, input.staged),
  };
}

/**
 * `--watch` fingerprint: every repo's patch plus its untracked list.
 *
 * shortcut: edits inside an already-untracked file do not change the signature; hash
 * untracked file stats if that matters.
 */
export async function workspaceSignature(
  input: ExtensionVcsDiffInput,
  context: ExtensionVcsLoadContext,
): Promise<string> {
  const { repos } = await collectWorkspace(input, context);
  return repos
    .map((repo) => `${repo.summary.name ?? ""}\0${repo.patch}\0${repo.untracked.join("\0")}`)
    .join("\u0001");
}

/** Run git synchronously for the (synchronous) watch-plan hook. */
function gitSync(dir: string, args: string[]) {
  return execFileSync("git", ["-C", dir, "--no-optional-locks", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Return whether `child` is `parent` or inside it. */
export function within(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Watch each repo's worktree (minus ignored dirs and nested repos) and its git metadata. */
export function workspaceWatchPlan(
  _input: ExtensionVcsDiffInput,
  context: ExtensionVcsLoadContext,
): ExtensionVcsWatchPlan {
  const root = resolve(context.cwd);
  const children = listChildRepos(root);
  const dirs = [...(existsSync(join(root, ".git")) ? [root] : []), ...children.map((c) => join(root, c))];
  const targets: ExtensionVcsDirectoryTreeWatchTarget[] = [];

  for (const dir of dirs) {
    let ignored: string[] = [];
    let gitDir = join(dir, ".git");
    let commonDir = gitDir;
    try {
      ignored = gitSync(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        .split("\0")
        .filter((path) => path.endsWith("/"))
        .map((path) => join(dir, path));
      const [absGitDir, absCommonDir] = gitSync(dir, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ])
        .trim()
        .split("\n");
      gitDir = absGitDir ?? gitDir;
      commonDir = absCommonDir ?? gitDir;
    } catch {
      // A broken repo still gets a worktree target; reloads report its git error.
    }

    targets.push({
      kind: "directory-tree",
      directory: dir,
      ignoredRoots: [
        ...new Set([
          join(dir, ".git"),
          ...ignored,
          ...(dir === root ? children.map((c) => join(root, c)) : []),
        ]),
      ],
      sources: ["worktree"],
    });

    for (const meta of within(commonDir, gitDir) ? [commonDir] : [gitDir, commonDir]) {
      targets.push({
        kind: "directory-tree",
        directory: meta,
        ignoredRoots: [join(meta, "objects")],
        sources: ["vcs-metadata"],
      });
    }
  }

  return { coverage: "hybrid", targets };
}
