/**
 * Renders the Repos sidebar: one row per changed repo, in review order.
 *
 * Clicking a row jumps the review stream to that repo's first file. The row that
 * owns the selected file is highlighted. When the `only-repo` command has scoped
 * the review to one repo, clicking another row clears the scope and jumps there.
 */
import { useRef } from "react";
import type { ExtensionDiffFile, ExtensionPaneProps } from "hunkdiff/extension";
import { getRepoSummaries, locatePath, ROOT_REPO_LABEL, type RepoSummary } from "./workspace";

/** The repo the `only-repo` command scoped the review to, valid for one generation. */
export const repoScope: { current: { generation: string; repo: string | null } | null } = {
  current: null,
};

/** Return the active scope for this generation, or null once a reload retired it. */
export function activeScope(generation: string | null) {
  const scope = repoScope.current;
  return scope && scope.generation === generation ? scope : null;
}

/** Group files by owning repo, keyed by child folder name (`null` for the root repo). */
export function groupFilesByRepo(
  files: readonly ExtensionDiffFile[],
  summaries: readonly RepoSummary[],
): Map<string | null, ExtensionDiffFile[]> {
  const children = new Set(summaries.flatMap((s) => (s.name ? [s.name] : [])));
  const groups = new Map<string | null, ExtensionDiffFile[]>();
  for (const file of files) {
    const { repo } = locatePath(file.path, children);
    groups.set(repo, [...(groups.get(repo) ?? []), file]);
  }
  return groups;
}

/** Fit text to the pane width with an ellipsis. */
export function fit(text: string, width: number) {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Repos sidebar component. */
export function RepoPane({
  files,
  selectedFileId,
  reviewGeneration,
  width,
  height,
  theme,
  actions,
}: ExtensionPaneProps) {
  const summaries = getRepoSummaries();
  const scope = activeScope(reviewGeneration);

  // Remember the unscoped file list so rows for hidden repos can still be jumped to.
  const known = useRef<{ generation: string | null; files: readonly ExtensionDiffFile[] }>({
    generation: null,
    files: [],
  });
  if (!scope || known.current.generation !== reviewGeneration) {
    known.current = { generation: reviewGeneration, files };
  }

  const visible = groupFilesByRepo(files, summaries);
  const all = groupFilesByRepo(known.current.files, summaries);
  const selectedPath = files.find((file) => file.id === selectedFileId)?.path;
  const children = new Set(summaries.flatMap((s) => (s.name ? [s.name] : [])));
  const selectedRepo = selectedPath === undefined ? undefined : locatePath(selectedPath, children).repo;

  const jump = (repo: string | null) => {
    const target = all.get(repo)?.[0];
    if (!target) return;

    if (scope && scope.repo !== repo) {
      repoScope.current = null;
      actions.clearPresentationScope();
      // The scope clears on the next frame; select once the file is visible again.
      setTimeout(() => actions.selectFile(target.id), 0);
      return;
    }
    actions.selectFile(target.id);
  };

  const inner = Math.max(1, width - 1);

  return (
    <box style={{ width, height, flexDirection: "column", backgroundColor: theme.panel }}>
      <text
        content={fit(` Repos (${summaries.length})${scope ? " · scoped" : ""}`, width)}
        style={{ fg: theme.accent, bg: theme.panel }}
      />
      <scrollbox scrollY={true} width="100%" height={Math.max(1, height - 1)}>
        {summaries.map((summary) => {
          const key = summary.name ?? ROOT_REPO_LABEL;
          const repoFiles = visible.get(summary.name) ?? [];
          const additions = repoFiles.reduce((sum, file) => sum + file.stats.additions, 0);
          const deletions = repoFiles.reduce((sum, file) => sum + file.stats.deletions, 0);
          const selected = summary.name === selectedRepo;
          const hidden = repoFiles.length === 0;
          const bg = selected ? theme.selectedHunk : theme.panel;

          return (
            <box key={key} style={{ flexDirection: "column" }} onMouseDown={() => jump(summary.name)}>
              <text
                content={fit(`${selected ? "▸" : " "}${key}`, inner)}
                style={{ fg: hidden ? theme.muted : selected ? theme.accent : theme.text, bg }}
              />
              <text
                content={fit(
                  `   ${summary.branch} · ${summary.fileCount}f +${additions} -${deletions}`,
                  inner,
                )}
                style={{ fg: theme.muted, bg }}
              />
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
