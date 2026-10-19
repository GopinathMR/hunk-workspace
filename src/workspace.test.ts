import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionVcsDiffInput } from "hunkdiff/extension";
import {
  detectWorkspace,
  getRepoSummaries,
  loadWorkspace,
  locatePath,
  prefixRenameHeaders,
  routePathspecs,
  workspaceWatchPlan,
} from "./workspace";

const children = new Set(["api", "web"]);

describe("pure helpers", () => {
  test("prefixRenameHeaders prefixes bare and quoted rename/copy paths only", () => {
    const patch = [
      "diff --git a/api/old.ts b/api/new.ts",
      "rename from old.ts",
      'rename to "n\\303\\251w.ts"',
      "copy from x.ts",
      "+rename from body-line-stays",
    ].join("\n");
    expect(prefixRenameHeaders(patch, "api/").split("\n")).toEqual([
      "diff --git a/api/old.ts b/api/new.ts",
      "rename from api/old.ts",
      'rename to "api/n\\303\\251w.ts"',
      "copy from api/x.ts",
      "+rename from body-line-stays",
    ]);
    expect(prefixRenameHeaders("rename from a", "")).toBe("rename from a");
  });

  test("locatePath splits child-repo paths and keeps root paths whole", () => {
    expect(locatePath("api/src/x.ts", children)).toEqual({ repo: "api", rest: "src/x.ts" });
    expect(locatePath("README.md", children)).toEqual({ repo: null, rest: "README.md" });
    expect(locatePath("docs/api.md", children)).toEqual({ repo: null, rest: "docs/api.md" });
  });

  test("routePathspecs routes specs to their repo", () => {
    expect(routePathspecs(undefined, children)).toBeNull();
    const routed = routePathspecs(["api/", "web/src", "README.md"], children);
    expect(routed?.get("api")).toEqual(["."]);
    expect(routed?.get("web")).toEqual(["src"]);
    expect(routed?.get(null)).toEqual(["README.md"]);
  });
});

describe("workspace load", () => {
  let root = "";
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8" });
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  const initRepo = (dir: string, files: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "Test");
    for (const [path, text] of Object.entries(files)) write(join(dir, path), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
  };
  const input = (overrides: Partial<ExtensionVcsDiffInput> = {}) =>
    ({ kind: "vcs", staged: false, options: {}, ...overrides }) as ExtensionVcsDiffInput;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hunk-ws-"));
    initRepo(root, { ".gitignore": "/api/\n/web/\n/clean/\n", "README.md": "root\n" });
    initRepo(join(root, "api"), { "src/a.ts": "one\n", "old.ts": "keep\nkeep\nkeep\n" });
    initRepo(join(root, "web"), { "index.ts": "w\n" });
    initRepo(join(root, "clean"), { "x.ts": "x\n" });

    write(join(root, "README.md"), "root changed\n");
    write(join(root, "api/src/a.ts"), "two\n");
    git(join(root, "api"), "mv", "old.ts", "renamed.ts");
    write(join(root, "api/new-untracked.ts"), "u\n");
    write(join(root, "web/index.ts"), "w2\n");
    git(join(root, "web"), "add", "index.ts");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("detects only a directory with two or more child repos", () => {
    expect(detectWorkspace(root)).toEqual({ id: "ws", repoRoot: root });
    expect(detectWorkspace(join(root, "api"))).toBeNull();
  });

  test("working tree review prefixes every child repo and skips clean repos", async () => {
    const result = await loadWorkspace(input(), { cwd: root });

    expect(result.patchText).toContain("diff --git a/README.md b/README.md");
    expect(result.patchText).toContain("diff --git a/api/src/a.ts b/api/src/a.ts");
    // `web` only has a staged change, so the unstaged review omits it.
    expect(result.patchText).not.toContain("web/index.ts");
    expect(result.untrackedPaths).toEqual(["api/new-untracked.ts"]);
    expect(getRepoSummaries().map((s) => s.name)).toEqual([null, "api"]);
    expect(getRepoSummaries()[1]).toMatchObject({ branch: "main", fileCount: 2 });

    const read = result.readFileSource!;
    expect(await read({ path: "api/src/a.ts", changeType: "change", isUntracked: false, side: "old" })).toBe("one\n");
    expect(await read({ path: "api/src/a.ts", changeType: "change", isUntracked: false, side: "new" })).toBe("two\n");
    expect(await read({ path: "README.md", changeType: "change", isUntracked: false, side: "old" })).toBe("root\n");
    expect(await read({ path: "api/new-untracked.ts", changeType: "new", isUntracked: true, side: "old" })).toBeNull();
  });

  test("staged review reads HEAD and index", async () => {
    const result = await loadWorkspace(input({ staged: true }), { cwd: root });
    expect(result.patchText).toContain("diff --git a/web/index.ts b/web/index.ts");
    expect(result.patchText).toContain("rename from api/old.ts");
    expect(result.patchText).toContain("rename to api/renamed.ts");
    expect(result.untrackedPaths).toEqual([]);

    const read = result.readFileSource!;
    expect(await read({ path: "web/index.ts", changeType: "change", isUntracked: false, side: "old" })).toBe("w\n");
    expect(await read({ path: "web/index.ts", changeType: "change", isUntracked: false, side: "new" })).toBe("w2\n");
  });

  test("pathspecs narrow the review to the named repo", async () => {
    const result = await loadWorkspace(input({ pathspecs: ["api/src"] }), { cwd: root });
    expect(result.patchText).toContain("api/src/a.ts");
    expect(result.patchText).not.toContain("README.md");
    expect(result.patchText).not.toContain("web/");
  });

  test("revision ranges are rejected with a user error", async () => {
    await expect(loadWorkspace(input({ range: "main" }), { cwd: root })).rejects.toMatchObject({
      name: "HunkExtensionUserError",
    });
  });

  test("watch plan covers each worktree and its git dir, excluding nested repos from root", () => {
    const plan = workspaceWatchPlan(input(), { cwd: root });
    const rootTarget = plan.targets.find((t) => t.directory === root);
    expect(rootTarget?.kind === "directory-tree" && rootTarget.ignoredRoots).toContain(join(root, "api"));
    expect(plan.targets.some((t) => t.directory === join(root, "web"))).toBe(true);
    expect(plan.targets.filter((t) => t.sources.includes("vcs-metadata"))).toHaveLength(4);
  });
});
