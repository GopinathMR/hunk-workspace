import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listStaged, parseNumstat, resolveOwner, stageFile, stageFolder, unstageFile, unstageFolder } from "./stage";

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

test("parseNumstat reads plain, binary and rename entries", () => {
  expect(parseNumstat("3\t1\ta.ts\0-\t-\timg.png\0" + "2\t0\t\0old.ts\0new.ts\0")).toEqual([
    { path: "a.ts", additions: 3, deletions: 1 },
    { path: "img.png", additions: 0, deletions: 0 },
    { path: "new.ts", previousPath: "old.ts", additions: 2, deletions: 0 },
  ]);
  expect(parseNumstat("")).toEqual([]);
});

describe("stage/unstage in the owning repo", () => {
  let root = "";
  let bare = "";
  const staged = (dir: string) => git(dir, "diff", "--cached", "--name-status").trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hunk-stage-"));
    initRepo(root, { ".gitignore": "/api/\n/web/\n", "README.md": "root\n" });
    initRepo(join(root, "api"), { ".gitignore": "/vendor/\n", "a.ts": "a\n", "gone.ts": "g\n", "old.ts": "o\n" });
    initRepo(join(root, "web"), { "w.ts": "w\n" });
    initRepo(join(root, "api/vendor/lib"), { "l.ts": "l\n" });
    bare = mkdtempSync(join(tmpdir(), "hunk-bare-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  test("resolveOwner walks up to the nearest repo", async () => {
    const real = realpathSync(root);
    expect(await resolveOwner(root, "README.md")).toEqual({ repoDir: real, relPath: "README.md" });
    expect(await resolveOwner(root, "api/src/deep/new.ts")).toEqual({
      repoDir: join(real, "api"),
      relPath: "src/deep/new.ts",
    });
    expect(await resolveOwner(root, "api/vendor/lib/l.ts")).toEqual({
      repoDir: join(real, "api/vendor/lib"),
      relPath: "l.ts",
    });
  });

  test("resolveOwner returns null outside any workspace repo", async () => {
    expect(await resolveOwner(bare, "x.txt")).toBeNull();
    await expect(stageFile(bare, { path: "x.txt" })).rejects.toThrow("Not in a git repo: x.txt");
  });

  test("stages and unstages root, child and nested repo files in their own repo", async () => {
    write(join(root, "README.md"), "root2\n");
    write(join(root, "api/a.ts"), "a2\n");
    write(join(root, "api/vendor/lib/l.ts"), "l2\n");
    write(join(root, "web/new.ts"), "n\n");

    await stageFile(root, { path: "README.md" });
    await stageFile(root, { path: "api/a.ts" });
    await stageFile(root, { path: "api/vendor/lib/l.ts" });
    await stageFile(root, { path: "web/new.ts" });

    expect(staged(root)).toBe("M\tREADME.md");
    expect(staged(join(root, "api"))).toBe("M\ta.ts");
    expect(staged(join(root, "api/vendor/lib"))).toBe("M\tl.ts");
    expect(staged(join(root, "web"))).toBe("A\tnew.ts");

    await unstageFile(root, { path: "api/a.ts" });
    await unstageFile(root, { path: "web/new.ts" });
    expect(staged(join(root, "api"))).toBe("");
    expect(staged(join(root, "web"))).toBe("");
  });

  test("stages and unstages a deletion", async () => {
    unlinkSync(join(root, "api/gone.ts"));
    await stageFile(root, { path: "api/gone.ts" });
    expect(staged(join(root, "api"))).toBe("D\tgone.ts");
    await unstageFile(root, { path: "api/gone.ts" });
    expect(staged(join(root, "api"))).toBe("");
  });

  test("a rename unstages and restages as a rename", async () => {
    const api = join(root, "api");
    git(api, "mv", "old.ts", "renamed.ts");
    const rename = { path: "api/renamed.ts", previousPath: "api/old.ts" };

    await unstageFile(root, rename);
    expect(staged(api)).toBe("");
    await stageFile(root, rename);
    expect(git(api, "diff", "--cached", "--name-status", "-M").trim()).toBe("R100\told.ts\trenamed.ts");
  });

  test("listStaged lists every repo's staged files with workspace paths", async () => {
    // Left staged by the tests above: root README, the api rename, the nested repo file.
    expect(await listStaged(root)).toEqual([
      { repo: "", path: "README.md", previousPath: undefined, additions: 1, deletions: 1 },
      { repo: "api", path: "api/renamed.ts", previousPath: "api/old.ts", additions: 0, deletions: 0 },
      { repo: "api/vendor/lib", path: "api/vendor/lib/l.ts", previousPath: undefined, additions: 1, deletions: 1 },
    ]);
  });
});

describe("folder stage/unstage", () => {
  let root = "";
  const staged = (dir: string) => git(dir, "diff", "--cached", "--name-only").trim().split("\n").filter(Boolean);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hunk-folder-"));
    // The root repo does not ignore its children: a careless `git add -A` would add them as gitlinks.
    initRepo(root, { "README.md": "r\n" });
    initRepo(join(root, "api"), { "src/a.ts": "a\n", "b.ts": "b\n" });
    initRepo(join(root, "web"), { "w.ts": "w\n" });
    write(join(root, "README.md"), "r2\n");
    write(join(root, "api/src/a.ts"), "a2\n");
    write(join(root, "api/b.ts"), "b2\n");
    write(join(root, "web/w.ts"), "w2\n");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a sub-folder stages only its own files", async () => {
    expect(await stageFolder(root, "api/src")).toEqual([]);
    expect(staged(join(root, "api"))).toEqual(["src/a.ts"]);
    expect(await unstageFolder(root, "api/src")).toEqual([]);
    expect(staged(join(root, "api"))).toEqual([]);
  });

  test("the root folder stages each repo without adding child gitlinks", async () => {
    expect(await stageFolder(root, "")).toEqual([]);
    expect(staged(root)).toEqual(["README.md"]);
    expect(staged(join(root, "api"))).toEqual(["b.ts", "src/a.ts"]);
    expect(staged(join(root, "web"))).toEqual(["w.ts"]);

    expect(await unstageFolder(root, "")).toEqual([]);
    expect([...staged(root), ...staged(join(root, "api")), ...staged(join(root, "web"))]).toEqual([]);
  });

  test("a failing repo is reported while the others still stage", async () => {
    const lock = join(root, "web/.git/index.lock");
    writeFileSync(lock, "");
    try {
      expect(await stageFolder(root, "")).toEqual(["web"]);
      expect(staged(join(root, "api"))).toEqual(["b.ts", "src/a.ts"]);
    } finally {
      unlinkSync(lock);
    }
  });
});
