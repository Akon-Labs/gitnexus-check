/**
 * @brief: Compose the Hub-provided `aiSummary` digest into the deterministic
 *         PR comment. The LLM call itself lives on the GitNexus Hub (which
 *         holds the Azure credential and rate-limits the call) — the Action no
 *         longer talks to Azure. The Hub returns a ready-made `## Summary`
 *         block on the BlastResult; this module just splices it in and collapses
 *         the heavy detail beneath it so a huge PR doesn't flood the thread.
 *         When the Hub also returns a `sinceLastCommit` delta (a PR re-push),
 *         a "🔁 Since last commit" block is rendered above the digest so a
 *         reviewer sees the latest change first — all in the SAME single
 *         upsert-by-marker comment.
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
 *         body (empty-blast comment).
 *
 * @params: (rawComment: string)                      -> Full deterministic comment from renderComment.
 * @params: (digest: string)                          -> The `## Summary` block from the Hub (aiSummary).
 * @params: (sinceLastCommit?: SinceLastCommit|null)  -> Optional Hub delta; rendered above the digest.
 * @returns: string — the composed, concise comment. The COMMENT_MARKER stays the first line.
 */
export function composeWithDigest(
  rawComment: string,
  digest: string,
  sinceLastCommit?: SinceLastCommit | null,
): string {
  const block = digest.trim();
  const delta = sinceLastCommit ? buildDeltaBlock(sinceLastCommit) : '';
  const sep = '\n---\n';
  const i = rawComment.indexOf(sep);

  if (i === -1) {
    // No section divider (empty-blast comment): nothing heavy to collapse, so
    // never introduce a `---` divider or a `<details>` "📋 Full report" expander
    // this comment never had. The delta goes after the marker/header, above the
    // digest. When delta === '' AND there is no usable digest, this whole path
    // is skipped by the caller (main.ts) so today's byte-output is preserved;
    // when only a digest is present we keep today's append-the-digest layout.
    if (delta === '') {
      return `${rawComment.trimEnd()}\n\n---\n\n${block}\n`;
    }
    // Marker must remain the first line: split it off and insert the delta after
    // it, then the original remainder, then the digest (if any) at the bottom.
    const nl = rawComment.indexOf('\n');
    const markerLine = nl === -1 ? rawComment.trimEnd() : rawComment.slice(0, nl).trimEnd();
    const remainder = nl === -1 ? '' : rawComment.slice(nl + 1).trim();
    const head = remainder.length > 0 ? `${markerLine}\n\n${delta}\n${remainder}` : `${markerLine}\n\n${delta}`;
    return block.length > 0 ? `${head.trimEnd()}\n\n---\n\n${block}\n` : `${head.trimEnd()}\n`;
  }

  // Split at the first divider: head = marker/header/verdict/metrics, rest =
  // all the detail sections. Rebuild as head → delta → Summary → one collapsed
  // expander. The delta block sits ABOVE the `## Summary` digest so the reviewer
  // sees the latest change first.
  const head = rawComment.slice(0, i).trimEnd();
  const rest = rawComment.slice(i + sep.length).trim();
  const summary = buildDetailSummary(rawComment);
  // Delta-only sub-case (empty digest): emit the delta with NO `## Summary`
  // header and no digest splice — just head → delta → collapsed expander.
  const middle = delta === '' ? block : block === '' ? delta.trimEnd() : `${delta}\n${block}`;
  return (
    `${head}\n\n${middle}\n\n---\n\n` +
    `<details>\n<summary><b>${summary}</b></summary>\n\n${rest}\n\n</details>\n`
  );
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
