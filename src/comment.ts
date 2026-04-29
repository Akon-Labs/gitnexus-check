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

export function composeMarkdown(input: ComposeInput): string {
  const fails = input.checks.filter((c) => c.severity === 'fail');
  const warns = input.checks.filter((c) => c.severity === 'warn');
  const passes = input.checks.filter((c) => c.severity === 'pass');
  const issueCount = fails.length + warns.length;
  const total = input.checks.length;

  const headerLine =
    issueCount > 0
      ? `### ⚠️ ${issueCount} issue${issueCount === 1 ? '' : 's'} found`
      : `### ✅ All ${total} checks passed`;

  const issuesSection = [...fails, ...warns]
    .map((c) => {
      // Phase 13: per-check "Fix with Claude →" link, gated on the repo's
      // claude_enabled flag. We append AFTER the details list so the link
      // sits immediately under the actionable evidence.
      const fixLink =
        input.claudeEnabled && input.repoFullName
          ? claudeFixLink(input.repoFullName, input.prNumber, c.id)
          : null;
      const fixLine = fixLink ? `\n\n[**Fix with Claude →**](${fixLink})` : '';

      return `
#### ${c.severity === 'fail' ? '❌' : '⚠️'} ${c.title}
${c.summary}
${c.details
  .slice(0, 5)
  .map((d) => `- \`${d.location.file}:${d.location.line}\` — ${d.message}`)
  .join('\n')}
${c.details.length > 5 ? `- _… and ${c.details.length - 5} more_` : ''}${fixLine}
`.trim();
    })
    .join('\n\n');

  const passSection =
    passes.length > 0
      ? `### ✅ ${passes.length} check${passes.length === 1 ? '' : 's'} passed\n\n${passes.map((c) => `- ${c.title} · ${c.summary}`).join('\n')}`
      : '';

  return [
    MARKER,
    `## 🔍 GitNexus Checks · \`${input.branch}\` @ \`${input.commitSha.slice(0, 7)}\``,
    '',
    headerLine,
    '',
    issuesSection,
    '',
    passSection,
    '',
    `[**View full report**](${input.warRoomUrl}) · indexed at \`${input.indexedCommit.slice(0, 7)}\` · ran in ${(input.durationMs / 1000).toFixed(1)}s`,
    '',
    `---`,
    `*🤖 Want auto-generated tests for this PR? Comment \`@claude generate tests\`.*`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function findMarkerComment<T extends { body?: string | null; id: number }>(
  comments: T[],
): T | undefined {
  return comments.find((c) => (c.body ?? '').includes(MARKER));
}
