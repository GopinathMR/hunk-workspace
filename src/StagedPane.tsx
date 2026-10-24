/**
 * Renders the Staged sidebar: every staged file across the workspace, grouped by repo.
 *
 * Staged files leave Hunk's default review, so the pane keeps its own cursor. Clicking a
 * row or the `staged-up`/`staged-down` commands set it; while it is set, `x` unstages
 * that row. Main-view navigation clears it so `x` goes back to staging.
 */
import { useSyncExternalStore } from "react";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { fit } from "./RepoPane";
import type { StagedRow } from "./stage";
import { ROOT_REPO_LABEL } from "./workspace";

interface StagedState {
  rows: StagedRow[];
  /** Row index the pane cursor is on, or null when `x` acts on the main view. */
  cursor: number | null;
}

let state: StagedState = { rows: [], cursor: null };
const listeners = new Set<() => void>();

/** Staged rows and pane cursor, shared by the pane and the commands. */
export const stagedStore = {
  get: () => state,
  set(next: Partial<StagedState>) {
    const merged = { ...state, ...next };
    // Keep the cursor on a real row after the list shrinks.
    if (merged.cursor !== null) {
      merged.cursor = merged.rows.length === 0 ? null : Math.min(merged.cursor, merged.rows.length - 1);
    }
    state = merged;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Move the cursor one row, without wrapping; an unset cursor starts at the first row. */
export function moveCursor(step: 1 | -1) {
  const { rows, cursor } = stagedStore.get();
  if (rows.length === 0) return;
  const next = cursor === null ? 0 : Math.max(0, Math.min(rows.length - 1, cursor + step));
  stagedStore.set({ cursor: next });
}

/** Staged sidebar component. */
export function StagedPane({ width, height, theme }: ExtensionPaneProps) {
  const { rows, cursor } = useSyncExternalStore(stagedStore.subscribe, stagedStore.get);
  const inner = Math.max(1, width - 1);

  return (
    <box style={{ width, height, flexDirection: "column", backgroundColor: theme.panel }}>
      <text content={fit(` Staged (${rows.length})`, width)} style={{ fg: theme.accent, bg: theme.panel }} />
      <scrollbox scrollY={true} width="100%" height={Math.max(1, height - 1)}>
        {rows.map((row, index) => {
          const selected = index === cursor;
          const bg = selected ? theme.selectedHunk : theme.panel;
          const header = index === 0 || rows[index - 1]?.repo !== row.repo;
          const name = row.repo ? row.path.slice(row.repo.length + 1) : row.path;
          return (
            <box key={row.path} style={{ flexDirection: "column" }}>
              {header ? (
                <text content={fit(` ${row.repo || ROOT_REPO_LABEL}`, inner)} style={{ fg: theme.muted, bg: theme.panel }} />
              ) : null}
              <box onMouseDown={() => stagedStore.set({ cursor: index })}>
                <text
                  content={fit(`${selected ? "▸" : " "}  ${name} +${row.additions} -${row.deletions}`, inner)}
                  style={{ fg: selected ? theme.accent : theme.text, bg }}
                />
              </box>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
