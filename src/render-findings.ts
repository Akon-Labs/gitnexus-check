/**
 * @brief: Pure markdown renderers for the Wave-2 inline findings. Two surfaces:
 *         `renderFindingComment` produces one line-anchored PR *review* comment
 *         body per anchored finding (carrying a hidden fingerprint marker so a
 *         re-run reconciles in place), and `renderFallbackSection` produces the
 *         demoted section appended to the MAIN comment for findings that could
 *         not be anchored or failed to post. No I/O, no `core.*` — deterministic
 *         and fully fixture-testable, mirroring render-comment.ts.
 *
 *         Trust model: the Hub sanitizes title/rationale at source (its LLM
 *         gates). The Action is defence-in-depth — it additionally escapes
 *         anything it interpolates into markdown *structure* (HTML-comment
 *         delimiters that could clone/close our markers, `@`-mentions that could
 *         ping, and — critically — triple-backtick runs) and NEVER renders a
 *         committable suggestion fence in Wave 2.
 */

import type { FindingItem } from './types/blast-result';

/** Marker prefix embedded (as an HTML comment) at the top of every finding review comment. */
const FINDING_MARKER_PREFIX = '<!-- gitnexus-finding:v1:';

/** Max known-caller rows rendered inside one finding comment before a "+N more" trailer. */
const MAX_CALLERS = 5;

/** Default cap on fallback items and per-item rationale length (keeps the section budget-bounded). */
const FALLBACK_MAX_ITEMS = 10;
const FALLBACK_RATIONALE_CHARS = 200;

/**
 * @brief: Build the hidden marker embedded in a finding's review-comment body.
 *         The fingerprint round-trips through `findingFingerprintFromBody` so a
 *         later run can PATCH the same comment instead of duplicating it. Shared
 *         by the renderer, the reconciler (post-review.ts), and the tests so the
 *         scheme stays consistent.
 *
 * @params: (fingerprint: string) -> The finding's stable fingerprint.
 * @returns: string — `<!-- gitnexus-finding:v1:<fingerprint> -->`.
 */
export function findingMarker(fingerprint: string): string {
  return `${FINDING_MARKER_PREFIX}${fingerprint} -->`;
}

/** Matches a finding marker and captures its fingerprint (no whitespace in a fingerprint). */
const FINDING_MARKER_RE = /<!-- gitnexus-finding:v1:(\S+) -->/;

/**
 * @brief: Extract the finding fingerprint from a comment body, or null when the
 *         body carries no finding marker. Used by the reconciler to map an
 *         existing bot-authored review comment back to its finding.
 *
 * @params: (body: string) -> A review-comment body.
 * @returns: string | null — the fingerprint, or null.
 */
export function findingFingerprintFromBody(body: string): string | null {
  const m = FINDING_MARKER_RE.exec(body);
  return m ? m[1] : null;
}

/**
 * @brief: Render one finding as a PR review-comment body: the hidden fingerprint
 *         marker, a severity badge + title, the rationale prose, an optional
 *         known-callers list (deterministic findings only, capped), and a
 *         one-line "why this matters" footer naming GitNexus. Never emits a code
 *         fence, so no committable suggestion can be produced in Wave 2.
 *
 * @params: (item: FindingItem) -> A normalised finding (post-normalizeFindings).
 * @returns: string — the review-comment markdown body.
 */
export function renderFindingComment(item: FindingItem): string {
  const lines: string[] = [];
  lines.push(findingMarker(item.fingerprint));
  lines.push('');
  lines.push(`${severityBadge(item.severity)} — ${escapeInline(item.title)}`);
  lines.push('');

  const rationale = sanitizeProse(item.rationale);
  if (rationale.length > 0) {
    lines.push(rationale);
    lines.push('');
  }

  // Deterministic findings can prove who calls the changed symbol — list the
  // known callers (capped) so the reviewer sees who this change reaches.
  if (item.origin === 'deterministic' && item.callers && item.callers.length > 0) {
    lines.push('**Known callers** (not updated by this PR):');
    for (const c of item.callers.slice(0, MAX_CALLERS)) {
      lines.push(`- \`${callerLoc(c)}\``);
    }
    const hidden = item.callers.length - MAX_CALLERS;
    if (hidden > 0) lines.push(`- _(+${hidden} more)_`);
    lines.push('');
  }

  lines.push(footer(item));
  return lines.join('\n');
}

/**
 * @brief: Render the demoted "Findings not shown inline" section for the MAIN
 *         comment: findings that are `anchored: false` or whose inline post
 *         failed. Sorted most-severe first (errors before warnings, then by
 *         confidence), capped, with a "+N more" trailer and per-item rationale
 *         truncation so the section stays budget-bounded (it rides high in the
 *         main comment's truncation ladder, adjacent to the gate narrative).
 *         Returns '' when there is nothing to demote.
 *
 * @params: (items: FindingItem[]) -> Demoted / failed findings.
 * @params: (opts.maxItems?)       -> Override the item cap (default FALLBACK_MAX_ITEMS).
 * @returns: string — the markdown section, or '' when empty.
 */
export function renderFallbackSection(items: FindingItem[], opts?: { maxItems?: number }): string {
  if (items.length === 0) return '';
  const max = opts?.maxItems ?? FALLBACK_MAX_ITEMS;
  const sorted = [...items].sort(bySeverityThenConfidence);
  const shown = sorted.slice(0, max);

  const lines: string[] = [];
  lines.push('## Findings not shown inline');
  lines.push('');
  lines.push(
    `${items.length} GitNexus finding${items.length === 1 ? '' : 's'} ` +
      `${items.length === 1 ? 'is' : 'are'} not shown inline and summarized here:`,
  );
  lines.push('');
  for (const item of shown) {
    lines.push(`- ${renderFallbackItem(item)}`);
  }
  const hidden = sorted.length - shown.length;
  if (hidden > 0) {
    lines.push(`- _(+${hidden} more finding${hidden === 1 ? '' : 's'})_`);
  }
  return lines.join('\n');
}

/** One fallback bullet: badge + title + `path`(:line) + a truncated rationale tail. */
function renderFallbackItem(item: FindingItem): string {
  const badge = item.severity === 'error' ? '🔴' : '🟡';
  const loc = item.anchor
    ? `${escapeCode(item.path)}:${item.anchor.startLine}`
    : escapeCode(item.path);
  const rationale = truncate(escapeInline(item.rationale), FALLBACK_RATIONALE_CHARS);
  const tail = rationale.length > 0 ? ` — ${rationale}` : '';
  return `${badge} **${escapeInline(item.title)}** — \`${loc}\`${tail}`;
}

/** Severity → emoji + bold label for the finding badge. */
function severityBadge(severity: 'warning' | 'error'): string {
  return severity === 'error' ? '🔴 **Error**' : '🟡 **Warning**';
}

/** `path:line` for a known caller, dropping the suffix when the line is absent. */
function callerLoc(c: { filePath: string; startLine?: number }): string {
  const p = escapeCode(c.filePath);
  return typeof c.startLine === 'number' ? `${p}:${c.startLine}` : p;
}

/** One-line "why this matters" footer, naming GitNexus and tagging the check id. */
function footer(item: FindingItem): string {
  const tag =
    item.origin === 'deterministic'
      ? 'GitNexus proved this from your code graph'
      : 'GitNexus flagged this from your code graph';
  const check = item.checkId ? ` · \`${escapeCode(item.checkId)}\`` : '';
  return `_Why this matters: ${tag} — a caller or contract relies on what changed here._${check}`;
}

/** Order errors before warnings, then higher confidence first. */
function bySeverityThenConfidence(a: FindingItem, b: FindingItem): number {
  const sa = a.severity === 'error' ? 0 : 1;
  const sb = b.severity === 'error' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return b.confidence - a.confidence;
}

/** Trim to `max` chars, ending with an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * @brief: Neutralise the markdown-structure vectors in Hub free text — HTML
 *         comment delimiters (so text can't clone/close our markers), triple+
 *         backtick runs (so no fenced or committable-suggestion block can form),
 *         and `@`-mentions (so rationale can't ping people). Regular inline
 *         markdown (single backticks, bold, lists) is preserved for readability.
 */
function neutralizeMarkup(text: string): string {
  return text
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/`{3,}/g, '`')
    .replace(/@(?=[A-Za-z0-9_-])/g, '&#64;');
}

/** Neutralise + collapse to a single line (for titles and bullet rationales). */
function escapeInline(text: string): string {
  return neutralizeMarkup(text).replace(/\r?\n/g, ' ').trim();
}

/** Neutralise while preserving line breaks (for the multi-line rationale block). */
function sanitizeProse(text: string): string {
  return neutralizeMarkup(text).trim();
}

/**
 * @brief: Escape a value destined for an inline code span (`file:line`),
 *         matching render-comment.ts's escapeCell semantics: backticks become
 *         apostrophes (a single-` span can't contain a literal backtick), pipes
 *         are escaped, newlines collapse to spaces.
 */
function escapeCode(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\r?\n/g, ' ');
}
