import type { CheckSuiteResult } from './upload';
import { claudeFixLink } from './claude-commands';

export interface PipelineStage {
  /** Short stage name shown in the table's first column. */
  name: string;
  /** 'success' | 'failure' | 'skipped' — drives the icon + status pill. */
  status: 'success' | 'failure' | 'skipped';
  /** Free-form one-liner shown in the Details column. */
  details: string;
}

export interface CoverageMetric {
  /** Metric label — "Lines", "Branches", "Functions", "Statements". */
  metric: string;
  /** Hit count. */
  covered: number;
  /** Total instrumented count. */
  total: number;
  /** Optional baseline percentage for delta column (omit when no base). */
  basePct?: number;
}

export interface ComposeInput extends CheckSuiteResult {
  branch: string;
  commitSha: string;
  indexedCommit: string;
  /**
   * `owner/repo` string used to compose the GitHub comment-prefill URL
   * for "Fix with Claude →" links. Required when `claudeEnabled` is true.
   */
  repoFullName?: string;
  /**
   * Per-PR Claude opt-in. When `true` AND `repoFullName` is set, the
   * composer renders a "Fix with Claude →" link on each issues-section
   * check that has a matching entry in CLAUDE_COMMANDS.
   */
  claudeEnabled?: boolean;
  /**
   * Optional ordered pipeline stages. When provided, renders a
   * "Pipeline Status" table at the top mirroring the high-level
   * stages the action ran (indexing, checks, coverage, comment).
   * Omitted when the caller doesn't have stage timings (back-compat).
   */
  pipeline?: PipelineStage[];
  /**
   * Optional coverage metrics. When provided, renders a "Code Coverage"
   * table with progress bars per metric. Omit entirely when no coverage
   * data was uploaded — the section won't render rather than showing
   * "no data" placeholders.
   */
  coverage?: CoverageMetric[];
}

export const MARKER = '<!-- gitnexus-pr-comment-v1 -->';

const SEVERITY_ICON: Record<'fail' | 'warn' | 'pass', string> = {
  fail: '🔴',
  warn: '🟡',
  pass: '🟢',
};

const STAGE_ICON: Record<'success' | 'failure' | 'skipped', string> = {
  success: '✅',
  failure: '❌',
  skipped: '⚪',
};

const STAGE_PILL: Record<'success' | 'failure' | 'skipped', string> = {
  // Inline `code` rendering acts as a status pill on GitHub.
  success: '`success`',
  failure: '`failure`',
  skipped: '`skipped`',
};

/**
 * Unicode progress bar of `width` cells. `pct` is 0–100. Uses block
 * characters for filled cells and light-shade for empty. GitHub renders
 * these in monospace inside table cells, which keeps the bar aligned.
 */
function progressBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '`' + '█'.repeat(filled) + '░'.repeat(empty) + '`';
}

/**
 * Format a coverage delta (current - base) as a markdown cell:
 *   no base provided → em-dash placeholder
 *   delta = 0        → "= 0.0%"
 *   delta > 0        → "🔼 +0.5%"
 *   delta < 0        → "🔽 -0.5%"
 */
function formatDelta(currentPct: number, basePct?: number): string {
  if (basePct === undefined) return '—';
  const d = currentPct - basePct;
  const sign = d > 0 ? '+' : '';
  const arrow = Math.abs(d) < 0.05 ? '=' : d > 0 ? '🔼' : '🔽';
  return `${arrow} ${sign}${d.toFixed(1)}%`;
}

/**
 * Render the GitNexus PR comment with a multi-section dashboard
 * layout: Pipeline Status → Check Results → Code Coverage → Details.
 *
 * Each section is independent — sections without data simply don't
 * render, so older callers passing only `checks` still get a clean
 * comment, just without the dashboard sections.
 */
export function composeMarkdown(input: ComposeInput): string {
  const fails = input.checks.filter((c) => c.severity === 'fail');
  const warns = input.checks.filter((c) => c.severity === 'warn');
  const passes = input.checks.filter((c) => c.severity === 'pass');
  const total = input.checks.length;
  const durationSec = (input.durationMs / 1000).toFixed(1);

  // ── Headline ──────────────────────────────────────────────────────
  const headline =
    fails.length > 0
      ? `## 🔴 GitNexus CI Report — ${fails.length} failing`
      : warns.length > 0
        ? `## 🟡 GitNexus CI Report — ${warns.length} warning${warns.length === 1 ? '' : 's'}`
        : `## ✅ GitNexus CI Report — All checks passed`;

  const subline = [
    `**Branch:** \`${input.branch}\``,
    `**Commit:** [\`${input.commitSha.slice(0, 7)}\`](${input.warRoomUrl})`,
    `**Indexed:** \`${input.indexedCommit.slice(0, 7)}\``,
    `**Ran in:** \`${durationSec}s\``,
  ].join(' · ');

  // ── Pipeline Status table ─────────────────────────────────────────
  const pipelineSection =
    input.pipeline && input.pipeline.length > 0
      ? [
          '### Pipeline Status',
          '',
          '| Stage | Status | Details |',
          '| :-- | :-- | :-- |',
          ...input.pipeline.map(
            (s) =>
              `| ${STAGE_ICON[s.status]} ${s.name} | ${STAGE_PILL[s.status]} | ${s.details.replace(/\|/g, '\\|')} |`,
          ),
        ].join('\n')
      : '';

  // ── Check Results table ───────────────────────────────────────────
  const checkRows = input.checks
    .map((c) => {
      const icon = SEVERITY_ICON[c.severity];
      const verdict =
        c.severity === 'fail'
          ? `**${c.summary}**`
          : c.severity === 'warn'
            ? c.summary
            : `_${c.summary}_`;
      const compressed = verdict.length > 110 ? verdict.slice(0, 107) + '…' : verdict;
      return `| ${icon} | ${c.title} | ${compressed.replace(/\|/g, '\\|')} |`;
    })
    .join('\n');

  const checksSection = [
    `### Check Results · ${passes.length}/${total} passing`,
    '',
    '| | Check | Verdict |',
    '| :-: | :-- | :-- |',
    checkRows,
  ].join('\n');

  // ── Code Coverage section ────────────────────────────────────────
  const coverageSection =
    input.coverage && input.coverage.length > 0
      ? [
          '### 📊 Code Coverage',
          '',
          '| Metric | Coverage | Covered | Delta | Status |',
          '| :-- | --: | :-- | :-- | :-- |',
          ...input.coverage.map((m) => {
            const pct = m.total > 0 ? (m.covered / m.total) * 100 : 0;
            const pctStr = `**${pct.toFixed(2)}%**`;
            const covered = `\`${m.covered.toLocaleString()} / ${m.total.toLocaleString()}\``;
            const delta = formatDelta(pct, m.basePct);
            return `| ${m.metric} | ${pctStr} | ${covered} | ${delta} | ${progressBar(pct)} |`;
          }),
        ].join('\n')
      : '';

  // ── Per-issue collapsibles for fails + warns ─────────────────────
  const issuesSection = [...fails, ...warns]
    .map((c) => {
      const fixLink =
        input.claudeEnabled && input.repoFullName
          ? claudeFixLink(input.repoFullName, input.prNumber, c.id)
          : null;
      const fixLine = fixLink ? `\n\n[**Fix with Claude →**](${fixLink})` : '';

      const detailLines =
        c.details.length === 0
          ? '_no per-location details_'
          : c.details
              .slice(0, 10)
              .map((d) => `- \`${d.location.file}:${d.location.line}\` — ${d.message}`)
              .join('\n') +
            (c.details.length > 10 ? `\n- _… and ${c.details.length - 10} more_` : '');

      const sevIcon = c.severity === 'fail' ? '🔴' : '🟡';
      const sevLabel = c.severity === 'fail' ? 'Failed' : 'Warning';

      return [
        `<details>`,
        `<summary>${sevIcon} <b>${c.title}</b> — ${sevLabel}: ${c.summary}</summary>`,
        '',
        detailLines + fixLine,
        '',
        `</details>`,
      ].join('\n');
    })
    .join('\n\n');

  // ── Compose ───────────────────────────────────────────────────────
  return [
    MARKER,
    headline,
    subline,
    '',
    pipelineSection,
    pipelineSection ? '' : null,
    checksSection,
    '',
    coverageSection,
    coverageSection ? '' : null,
    issuesSection ? `### Details` : '',
    issuesSection,
    '',
    `[**View full report on the war-room dashboard →**](${input.warRoomUrl})`,
    '',
    `---`,
    `<sub>🤖 Need help? Comment \`@claude review this PR\` or \`@claude generate tests\`.</sub>`,
  ]
    .filter((s) => s !== null && s !== '')
    .join('\n');
}

export function findMarkerComment<T extends { body?: string | null; id: number }>(
  comments: T[],
): T | undefined {
  return comments.find((c) => (c.body ?? '').includes(MARKER));
}
