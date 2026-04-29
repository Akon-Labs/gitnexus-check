import type { CheckSuiteResult } from './upload';
import { claudeFixLink } from './claude-commands';

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
   * check that has a matching entry in CLAUDE_COMMANDS. When `false` the
   * comment is unchanged from the v1 shape — important for repos that
   * haven't installed the @claude workflow.
   */
  claudeEnabled?: boolean;
}

export const MARKER = '<!-- gitnexus-pr-comment-v1 -->';

const SEVERITY_ICON: Record<'fail' | 'warn' | 'pass', string> = {
  fail: '🔴',
  warn: '🟡',
  pass: '🟢',
};

/**
 * Render the GitNexus PR comment.
 *
 * Layout:
 *   1. Title + metadata badges (branch / commit / duration)
 *   2. Summary line ("X failed, Y warnings, Z passed")
 *   3. Results table (one row per check — icon + name + verdict)
 *   4. Per-issue collapsible <details> for fail + warn checks (showing
 *      detail rows, with optional "Fix with Claude →" CTA)
 *   5. Footer with full-report link
 *
 * The table at the top means the reader gets the verdict at a glance
 * without scrolling — same shape as SonarQube / CodeRabbit comments.
 * Pass-level checks stay in the table only (no separate noisy list).
 */
export function composeMarkdown(input: ComposeInput): string {
  const fails = input.checks.filter((c) => c.severity === 'fail');
  const warns = input.checks.filter((c) => c.severity === 'warn');
  const passes = input.checks.filter((c) => c.severity === 'pass');
  const total = input.checks.length;
  const durationSec = (input.durationMs / 1000).toFixed(1);

  // ── Top banner ─────────────────────────────────────────────────────
  const topBanner =
    fails.length > 0
      ? `### 🔴 ${fails.length} failing · ${warns.length} warning${warns.length === 1 ? '' : 's'} · ${passes.length}/${total} passing`
      : warns.length > 0
        ? `### 🟡 ${warns.length} warning${warns.length === 1 ? '' : 's'} · ${passes.length}/${total} passing`
        : `### ✅ All ${total} checks passed`;

  // ── Metadata badges (clickable shields-style) ─────────────────────
  const metaLine = [
    `**Branch:** \`${input.branch}\``,
    `**Commit:** [\`${input.commitSha.slice(0, 7)}\`](${input.warRoomUrl})`,
    `**Indexed:** \`${input.indexedCommit.slice(0, 7)}\``,
    `**Ran in:** \`${durationSec}s\``,
  ].join(' · ');

  // ── Results table (one row per check) ─────────────────────────────
  const tableRows = input.checks
    .map((c) => {
      const icon = SEVERITY_ICON[c.severity];
      const verdict =
        c.severity === 'fail'
          ? `**${c.summary}**`
          : c.severity === 'warn'
            ? c.summary
            : `_${c.summary}_`; // dim pass rows
      // Compress long verdicts so the table doesn't blow out horizontally.
      const compressedVerdict =
        verdict.length > 120 ? verdict.slice(0, 117) + '…' : verdict;
      return `| ${icon} | ${c.title} | ${compressedVerdict.replace(/\|/g, '\\|')} |`;
    })
    .join('\n');

  const table = ['| | Check | Verdict |', '| :-: | :-- | :-- |', tableRows].join('\n');

  // ── Per-issue collapsible details (fails first, warns second) ─────
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
    `## 🔍 GitNexus Checks`,
    metaLine,
    '',
    topBanner,
    '',
    table,
    '',
    issuesSection ? `### Details` : '',
    issuesSection,
    '',
    `[**View full report on the war-room dashboard →**](${input.warRoomUrl})`,
    '',
    `---`,
    `<sub>🤖 Need help? Comment \`@claude review this PR\` or \`@claude generate tests\`.</sub>`,
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export function findMarkerComment<T extends { body?: string | null; id: number }>(
  comments: T[],
): T | undefined {
  return comments.find((c) => (c.body ?? '').includes(MARKER));
}
