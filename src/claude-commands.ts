/**
 * Per-check @claude command map and helpers.
 *
 * Phase 13 of the CI integration plan. The map is intentionally duplicated
 * across the action (this file) and the Hub backend
 * (`gitnexus-hub/src/services/claude/commands.ts`) so the two artifacts
 * deploy independently — there is no runtime dependency between them.
 *
 * KEEP THIS FILE IN SYNC with `gitnexus-hub/src/services/claude/commands.ts`.
 *
 * The action uses these to render "Fix with Claude →" links in the PR
 * comment; the Hub backend uses them to validate the `checkId` body of the
 * `/api/repos/:id/prs/:prNumber/claude-trigger` route and post the matching
 * `@claude` command on behalf of the user.
 */

export const CLAUDE_COMMANDS: Record<string, string> = {
  'incomplete-rename': '@claude finish the rename in this PR — update all stale callers',
  'route-shape-drift': '@claude align consumers with the new route response shape',
  'dead-code': '@claude remove the unused symbols flagged in this check',
  'cycle-introduction': '@claude break the cycle introduced in this PR',
  'orphan-on-arrival': '@claude either wire up the new exports or remove them',
  'public-api-diff':
    '@claude check whether these public API changes need a semver bump in the changelog',
  'hot-path-edits':
    '@claude review the hot-path changes carefully — these are on critical execution flows',
  'no-framework': '@claude scaffold a test framework for this repo using the conventional setup',
  'coverage-gap':
    '@claude generate tests covering the uncovered changed lines flagged in this check',
};

/**
 * Build a GitHub comment-prefill URL for the given check on the given PR.
 * Clicking the link opens the issue/PR comment box pre-populated with the
 * canonical `@claude` command for that check, so the user just clicks
 * "Comment" to fire the workflow.
 *
 * Returns `null` when the check id is not in CLAUDE_COMMANDS — callers
 * should treat that as "no Fix link for this check".
 */
export function claudeFixLink(repo: string, prNumber: number, checkId: string): string | null {
  const cmd = CLAUDE_COMMANDS[checkId];
  if (!cmd) return null;
  const body = encodeURIComponent(cmd);
  return `https://github.com/${repo}/issues/${prNumber}#new-comment-form?body=${body}`;
}

/** Lookup helper used by the Hub-side claude-trigger route. */
export function getClaudeCommand(checkId: string): string | null {
  return CLAUDE_COMMANDS[checkId] ?? null;
}
