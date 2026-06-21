/**
 * @brief: Compose the Hub-provided `aiSummary` digest into the deterministic
 *         PR comment, and render the standalone "🔁 Since last commit" comment.
 *         The LLM call itself lives on the GitNexus Hub (which holds the Azure
 *         credential and rate-limits the call) — the Action no longer talks to
 *         Azure. The Hub returns a ready-made `## Summary` block on the
 *         BlastResult; `composeWithDigest` splices it into the MAIN review
 *         comment and collapses the heavy detail beneath it so a huge PR doesn't
 *         flood the thread. The since-last-commit delta is NOT part of the main
 *         comment: when the Hub returns a `sinceLastCommit` (a PR re-push),
 *         `renderSinceCommitComment` produces a SEPARATE per-commit comment that
 *         main.ts upserts under its own per-SHA marker, building a per-commit
 *         history in the thread without touching the main report.
 */

import type { SinceLastCommit } from './types/blast-result';

/**
 * @brief: Splice the Hub's summary digest into the deterministic comment and
 *         collapse the heavy detail beneath it. The default-visible comment
 *         becomes just the header, one-line verdict, metrics strip, and the
 *         readable `## Summary` digest — so a 160-symbol / 100-file PR no longer
 *         floods the thread. Every detail table is kept verbatim from the
 *         renderer but tucked inside ONE collapsed `<details>` expander, one
 *         click away. Falls back to appending the digest if there is no detail
 *         body (empty-blast comment). This produces the MAIN comment only — it
 *         carries no since-last-commit delta (that is a separate comment).
 *
 * @params: (rawComment: string) -> Full deterministic comment from renderComment.
 * @params: (digest: string)     -> The `## Summary` block from the Hub (aiSummary).
 * @returns: string — the composed, concise comment. The COMMENT_MARKER stays the first line.
 */
export function composeWithDigest(rawComment: string, digest: string): string {
  const block = digest.trim();
  const sep = '\n---\n';
  const i = rawComment.indexOf(sep);

  if (i === -1) {
    // No section divider (empty-blast comment): nothing heavy to collapse, so
    // never introduce a `---` divider or a `<details>` "📋 Full report" expander
    // this comment never had. Keep today's append-the-digest layout so the
    // byte-output is preserved.
    return `${rawComment.trimEnd()}\n\n---\n\n${block}\n`;
  }

  // Split at the first divider: head = marker/header/verdict/metrics, rest =
  // all the detail sections. Rebuild as head → Summary → one collapsed expander.
  const head = rawComment.slice(0, i).trimEnd();
  const rest = rawComment.slice(i + sep.length).trim();
  const summary = buildDetailSummary(rawComment);
  return (
    `${head}\n\n${block}\n\n---\n\n` +
    `<details>\n<summary><b>${summary}</b></summary>\n\n${rest}\n\n</details>\n`
  );
}

/** Per-SHA marker prefix for the standalone since-last-commit comment. */
const SINCE_COMMIT_MARKER_PREFIX = '<!-- gitnexus-since-commit:';

/**
 * @brief: Build the per-SHA HTML-comment marker that identifies a single
 *         "🔁 Since last commit" comment for upsert-by-marker. A distinct
 *         headSha yields a distinct marker (a new comment); the same headSha
 *         yields the same marker (an in-place update on re-run). main.ts and
 *         the tests share this one definition so the scheme stays consistent.
 *
 * @params: (headSha: string) -> The PR head commit sha this delta is anchored to.
 *
 * @returns: string — `<!-- gitnexus-since-commit:<headSha> -->`.
 */
export function sinceCommitMarker(headSha: string): string {
  return `${SINCE_COMMIT_MARKER_PREFIX}${headSha} -->`;
}

/**
 * @brief: Render the full body of the standalone "🔁 Since last commit" comment.
 *         The body begins with the per-SHA marker line (so postOrUpdateComment
 *         can upsert by it), followed by the delta block. The `summary` is
 *         Hub-generated prose (same trust level as the aiSummary digest) and is
 *         spliced as-is — the renderer escapes nothing here, matching how the
 *         digest is treated. Anchored on the full `headSha` in the marker; the
 *         visible header shows the 7-char short sha.
 *
 * @params: (sinceLastCommit: SinceLastCommit) -> Hub delta (headSha + summary).
 *
 * @returns: string — marker line, blank line, then the delta block.
 */
export function renderSinceCommitComment(sinceLastCommit: SinceLastCommit): string {
  return `${sinceCommitMarker(sinceLastCommit.headSha)}\n\n${buildDeltaBlock(sinceLastCommit)}`;
}

/**
 * @brief: Truncate a commit sha to its 7-char short form for display. Pure
 *         presentation — no typeof guard, because normalizeSinceLastCommit
 *         already guarantees `sha` is a non-empty string before it reaches here.
 */
function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/**
 * @brief: Render the "🔁 Since last commit" delta block. The `summary` is
 *         Hub-generated prose (same trust level as the aiSummary digest) and is
 *         spliced as-is — the renderer escapes nothing here, matching how the
 *         digest is treated. Ends with a single trailing newline.
 */
function buildDeltaBlock(d: SinceLastCommit): string {
  return `## 🔁 Since last commit (\`${shortSha(d.headSha)}\`)\n${d.summary}\n`;
}

/**
 * @brief: Build the collapsed-expander summary line, e.g.
 *         "📋 Full report — 162 symbols · 117 files · 58 flows", pulling the
 *         counts straight from the renderer's own section headers so they stay
 *         exact. Returns a bare label when no counts are found.
 */
function buildDetailSummary(rawComment: string): string {
  const sym = rawComment.match(/Symbol Changes \((\d+)\)/);
  const files = rawComment.match(/Changed Files \((\d+)\)/);
  const flows = rawComment.match(/Affected Flows \((\d+)\)/);
  const parts: string[] = [];
  if (sym) parts.push(`${sym[1]} symbols`);
  if (files) parts.push(`${files[1]} files`);
  if (flows) parts.push(`${flows[1]} flows`);
  return parts.length > 0 ? `📋 Full report — ${parts.join(' · ')}` : '📋 Full report';
}
