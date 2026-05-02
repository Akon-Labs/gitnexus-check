import * as exec from '@actions/exec';

/**
 * Diff stats computed locally by the action from `git diff --numstat`
 * + `git diff --name-status` against the PR's base SHA.
 *
 * The shape mirrors `services/context-pack/types.ts:DiffStats` on the
 * Hub side, with one addition: `rawDiff` (only included when caller
 * opts in via `withRawDiff`) — the Hub builder uses it as a fallback
 * when `files` is empty (e.g. across-fork PRs where the runner can't
 * fetch the base ref).
 */
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  added: number;
  deleted: number;
  /** Only set when status === 'renamed'. */
  previousPath?: string;
}

export interface DiffStats {
  files: DiffFile[];
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  hasRename: boolean;
  /** True when the diff is "big" by the lazy-reindex threshold. */
  isBigDiff: boolean;
}

/**
 * Threshold above which we always run a full reindex. Mirrors the
 * design-doc default; keep this in sync with any Hub-side check.
 */
export const BIG_DIFF_FILE_THRESHOLD = 50;

/**
 * Compute diff stats by shelling out to `git`. The runner has both
 * the head SHA checked out (via actions/checkout) and the base SHA
 * fetchable via `fetch-depth: 0`, so this is a local-only operation.
 *
 * If git fails for any reason (e.g. shallow checkout, force-push that
 * orphaned the base SHA), we return an empty-files diff with `isBigDiff`
 * conservatively set to `true` so the action falls back to the safer
 * full-reindex path. The Hub side handles `files: []` gracefully.
 */
export async function computeDiffStats(opts: {
  baseSha: string;
  headSha: string;
  cwd: string;
}): Promise<DiffStats> {
  // numstat: per-file added/deleted counts (or `-` for binary).
  // name-status: per-file status letter (A/M/D/R<score>).
  // We run both in parallel-ish (sequential here because @actions/exec
  // doesn't expose Promise.all-friendly streaming, but the cost is
  // ms-level so it's not worth the extra plumbing).
  // Run each git command in its own try/catch so partial output
  // survives — if --numstat succeeds but --name-status fails we'd
  // otherwise discard the valid line counts and force an unnecessary
  // full reindex. With independent guards we keep what we got and
  // simply lose rename detection on the second-cmd-fail path.
  let numstatOut = '';
  let nameStatusOut = '';
  try {
    await exec.exec('git', ['diff', '--numstat', `${opts.baseSha}..${opts.headSha}`], {
      cwd: opts.cwd,
      listeners: {
        stdout: (chunk) => {
          numstatOut += chunk.toString();
        },
      },
      silent: true,
    });
  } catch {
    // numstat failed — we have nothing to derive from. Conservative
    // fallback: assume big diff so we reindex rather than ship a wrong
    // lazy decision.
    return {
      files: [],
      filesChanged: 0,
      linesAdded: 0,
      linesDeleted: 0,
      hasRename: false,
      isBigDiff: true,
    };
  }
  try {
    await exec.exec('git', ['diff', '--name-status', `${opts.baseSha}..${opts.headSha}`], {
      cwd: opts.cwd,
      listeners: {
        stdout: (chunk) => {
          nameStatusOut += chunk.toString();
        },
      },
      silent: true,
    });
  } catch {
    // name-status failed but numstat succeeded — proceed with what we
    // have. We lose rename detection (hasRename will be false when it
    // might have been true), which means the lazy-reindex path may
    // skip a rename PR. Acceptable: the user can always force the deep
    // review with the `gitnexus-deep-review` label.
    nameStatusOut = '';
  }

  return parseDiff(numstatOut, nameStatusOut);
}

/**
 * Parse `git diff --numstat` + `git diff --name-status` output into a
 * normalised DiffStats object. Exported for testing — the live
 * `computeDiffStats` calls this with real git output.
 *
 * Format:
 *   numstat:      "<added>\t<deleted>\t<path>" (or "<a>\t<d>\t<old>\t<new>" for renames)
 *                 binary files report "-\t-\t<path>"
 *   name-status:  "<letter>\t<path>" (or "R<score>\t<old>\t<new>" for renames)
 */
export function parseDiff(numstat: string, nameStatus: string): DiffStats {
  // Build a status lookup keyed by the new path. For renames we ALSO
  // index by the old path so a numstat row that only lists one of the
  // two (depending on git version) can still be matched.
  const statusByPath = new Map<string, { status: DiffFile['status']; previousPath?: string }>();
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (code.startsWith('R') && parts.length >= 3) {
      const oldPath = parts[1]!;
      const newPath = parts[2]!;
      statusByPath.set(newPath, { status: 'renamed', previousPath: oldPath });
      statusByPath.set(oldPath, { status: 'renamed', previousPath: oldPath });
    } else if (parts.length >= 2) {
      const status = mapStatusLetter(code);
      statusByPath.set(parts[1]!, { status });
    }
  }

  const files: DiffFile[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  let hasRename = false;

  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    // For renames numstat emits "<a>\t<d>\t<old>\t<new>" OR
    // "<a>\t<d>\t{<old> => <new>}". We only handle the first form
    // here; the second is suppressed by `-c diff.renames=true` style
    // configs but we don't enforce it. If we see a 4-part row, that's
    // a rename.
    let path: string;
    let previousPath: string | undefined;
    if (parts.length === 4) {
      previousPath = parts[2]!;
      path = parts[3]!;
    } else {
      path = parts[2]!;
    }

    const addedRaw = parts[0]!;
    const deletedRaw = parts[1]!;
    // Binary files: "-\t-\t<path>". Treat as 0/0 for line counts but
    // include the file so callers see it.
    const added = addedRaw === '-' ? 0 : Number(addedRaw);
    const deleted = deletedRaw === '-' ? 0 : Number(deletedRaw);

    const statusEntry = statusByPath.get(path) ?? statusByPath.get(previousPath ?? '');
    let status: DiffFile['status'];
    if (statusEntry) {
      status = statusEntry.status;
      if (!previousPath && statusEntry.previousPath) previousPath = statusEntry.previousPath;
    } else {
      // Fall back to inferring from numstat shape: 4-part = rename,
      // otherwise treat as modified (we can't reliably detect adds vs
      // mods from numstat alone).
      status = previousPath ? 'renamed' : 'modified';
    }

    if (status === 'renamed') hasRename = true;

    const file: DiffFile = { path, status, added, deleted };
    if (previousPath) file.previousPath = previousPath;
    files.push(file);
    totalAdded += Number.isFinite(added) ? added : 0;
    totalDeleted += Number.isFinite(deleted) ? deleted : 0;
  }

  return {
    files,
    filesChanged: files.length,
    linesAdded: totalAdded,
    linesDeleted: totalDeleted,
    hasRename,
    isBigDiff: files.length > BIG_DIFF_FILE_THRESHOLD,
  };
}

function mapStatusLetter(letter: string): DiffFile['status'] {
  // Take only the first char — name-status sometimes appends a score
  // (e.g. "R100", "C75").
  const c = (letter[0] ?? '').toUpperCase();
  switch (c) {
    case 'A':
      return 'added';
    case 'D':
      return 'removed';
    case 'R':
      return 'renamed';
    case 'M':
    default:
      return 'modified';
  }
}

/**
 * Lazy-reindex decision. The action skips the reindex (and just calls
 * /context-pack against the main-graph + raw diff) when:
 *   - the user has NOT applied the deep-review label, AND
 *   - the diff has no renames, AND
 *   - the diff is below the file-count threshold.
 *
 * Anything else triggers a full reindex.
 */
export function shouldReindex(
  diffStats: Pick<DiffStats, 'hasRename' | 'isBigDiff'>,
  opts: { hasDeepReviewLabel: boolean; lazyReindex: boolean },
): boolean {
  if (!opts.lazyReindex) return true;
  if (opts.hasDeepReviewLabel) return true;
  if (diffStats.hasRename) return true;
  if (diffStats.isBigDiff) return true;
  return false;
}
