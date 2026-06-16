/**
 * @brief: Compose the Hub-provided `aiSummary` digest into the deterministic
 *         PR comment. The LLM call itself lives on the GitNexus Hub (which
 *         holds the Azure credential and rate-limits the call) — the Action no
 *         longer talks to Azure. The Hub returns a ready-made `## Summary`
 *         block on the BlastResult; this module just splices it in and collapses
 *         the heavy detail beneath it so a huge PR doesn't flood the thread.
 */

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
 * @params: (rawComment: string) -> Full deterministic comment from renderComment.
 * @params: (digest: string)     -> The `## Summary` block from the Hub (aiSummary).
 * @returns: string — the composed, concise comment.
 */
export function composeWithDigest(rawComment: string, digest: string): string {
  const block = digest.trim();
  const sep = '\n---\n';
  const i = rawComment.indexOf(sep);
  if (i === -1) {
    // No section divider (empty-blast comment): nothing heavy to collapse.
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
