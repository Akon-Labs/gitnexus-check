/**
 * @brief: Pure markdown renderer for the PR comment body. Consumes a
 *         normalised BlastResult (post-isBlastResult, post-normalize) and
 *         emits a single string under CHAR_BUDGET. Performs progressive
 *         truncation when over budget per v1-integration-plan.md §8. No
 *         I/O, no `core.*`, no axios — this module is deterministic and
 *         fully fixture-testable.
 */

import type {
  AffectedModule,
  BlastResult,
  RiskFile,
  SymbolRef,
} from './types/blast-result';

/**
 * @brief: HTML-comment marker that the poster searches for when deciding
 *         whether to PATCH (update) or POST (create) the comment. Must
 *         appear verbatim as the first line of every rendered body so the
 *         substring scan in `post-comment.ts` is O(n) over comment count
 *         rather than parsing markdown.
 */
export const COMMENT_MARKER = '<!-- gitnexus-review-v1 -->';

/**
 * @brief: Maximum byte length (UTF-16 chars) of the rendered comment. The
 *         GitHub hard cap is 65,536; this value leaves ~5,500-char
 *         headroom for the marker, truncation footer, and any rounding
 *         drift introduced by `Buffer.byteLength` vs `.length`.
 */
export const CHAR_BUDGET = 60_000;

const TOP_N_BLAST_LIST = 20;
const TOP_N_MODULE_ROWS = 20;
const TOP_N_SYMBOL_ROWS = 50;
const TOP_N_RISK_FILES = 20;

/**
 * @brief: Render a BlastResult into the v1 comment markdown. Always starts
 *         with COMMENT_MARKER. Sections are emitted only when their
 *         underlying array is non-empty; otherwise the renderer falls
 *         through to a single "no impact detected" sentence. When the
 *         initial render exceeds CHAR_BUDGET, the function shrinks the
 *         body in stages per v1-integration-plan.md §8 (drop details,
 *         cap lists, drop sections) and appends a truncation footer.
 *
 * @params: (blast: BlastResult) -> Hub response, already validated and normalised.
 * @params: (opts.prNumber: number) -> GitHub PR number for the heading.
 * @params: (opts.hubUrl: string)   -> Hub base URL, used in the footer link.
 *
 * @returns: string — markdown body ≤ CHAR_BUDGET.
 */
export function renderComment(
  blast: BlastResult,
  opts: { prNumber: number; hubUrl: string },
): string {
  // Render every variant once, then pick the smallest that fits.
  // Stages are ordered most-detail → least-detail per the truncation plan.
  const variants: Array<() => string> = [
    () => buildBody(blast, opts, { detailLevel: 'full' }),
    () => buildBody(blast, opts, { detailLevel: 'no-details' }),
    () => buildBody(blast, opts, { detailLevel: 'capped' }),
    () => buildBody(blast, opts, { detailLevel: 'minimal' }),
    () => buildBody(blast, opts, { detailLevel: 'headline-only' }),
  ];

  for (const variant of variants) {
    const body = variant();
    if (body.length <= CHAR_BUDGET) return body;
  }
  // Even the headline variant blew the budget — clamp hard.
  return variants[variants.length - 1]().slice(0, CHAR_BUDGET);
}

type DetailLevel = 'full' | 'no-details' | 'capped' | 'minimal' | 'headline-only';

/**
 * @brief: Build the comment body at a given detail level. Internal — the
 *         exported renderComment iterates this with progressively lower
 *         detail until the result fits CHAR_BUDGET.
 */
function buildBody(
  blast: BlastResult,
  opts: { prNumber: number; hubUrl: string },
  cfg: { detailLevel: DetailLevel },
): string {
  const parts: string[] = [];
  parts.push(COMMENT_MARKER);
  parts.push('');
  parts.push(`## GitNexus Review: PR #${opts.prNumber}`);
  parts.push('');

  const headline = buildHeadline(blast);
  if (headline) {
    parts.push(`> ${headline}`);
    parts.push('');
  }

  if (cfg.detailLevel === 'headline-only') {
    appendFooter(parts, blast, opts.hubUrl, /* truncated */ true);
    return parts.join('\n');
  }

  if (isEmptyBlast(blast)) {
    parts.push(
      'No symbol changes, blast radius, architecture impact, or API surface changes detected.',
    );
    parts.push('');
    appendFooter(parts, blast, opts.hubUrl, false);
    return parts.join('\n');
  }

  const renderedAny = appendSections(parts, blast, cfg.detailLevel);
  if (!renderedAny) {
    parts.push(
      'No symbol changes, blast radius, architecture impact, or API surface changes detected.',
    );
    parts.push('');
  }
  appendFooter(
    parts,
    blast,
    opts.hubUrl,
    blast.truncated || cfg.detailLevel !== 'full',
  );
  return parts.join('\n');
}

/**
 * @brief: Render the four signal sections in canonical order. Returns
 *         true if at least one section was emitted, so the caller can
 *         decide whether to fall back to the "no impact" sentence.
 */
function appendSections(
  parts: string[],
  blast: BlastResult,
  detail: DetailLevel,
): boolean {
  let rendered = false;
  if (blast.affectedModules.length > 0) {
    parts.push(renderArchitectureImpact(blast.affectedModules, detail));
    parts.push('');
    rendered = true;
  }
  if (detail !== 'minimal' && hasBlastRadius(blast)) {
    parts.push(renderBlastRadius(blast, detail));
    parts.push('');
    rendered = true;
  }
  if (detail !== 'minimal' && blast.changedSymbols.length > 0) {
    parts.push(renderSymbolChanges(blast.changedSymbols, detail));
    parts.push('');
    rendered = true;
  }
  if (detail !== 'minimal' && detail !== 'capped') {
    const surface = projectApiSurface(blast.changedSymbols);
    if (surface.length > 0) {
      parts.push(renderApiSurfaceDelta(surface));
      parts.push('');
      rendered = true;
    }
  }
  if (detail === 'full' && blast.riskFiles.length > 0) {
    parts.push(renderRiskFiles(blast.riskFiles));
    parts.push('');
    rendered = true;
  }
  return rendered;
}

/**
 * @brief: Single-line summary for the blockquote at the top. Empty string
 *         when there's nothing to summarise (the renderer suppresses the
 *         blockquote entirely in that case).
 */
function buildHeadline(blast: BlastResult): string {
  const bits: string[] = [];
  bits.push(`Blast level: \`${blast.blastLevel}\``);
  const total = blast.d1Symbols.length + blast.d2Symbols.length + blast.d3Symbols.length;
  if (total > 0) bits.push(`${total} dependent symbol${total === 1 ? '' : 's'}`);
  if (blast.affectedModules.length > 0) {
    const m = blast.affectedModules.length;
    bits.push(`${m} module${m === 1 ? '' : 's'} touched`);
  }
  if (blast.stale) bits.push('_(stale — re-run for fresh analysis)_');
  return bits.join(' · ');
}

function isEmptyBlast(blast: BlastResult): boolean {
  return (
    blast.changedSymbols.length === 0 &&
    blast.d1Symbols.length === 0 &&
    blast.d2Symbols.length === 0 &&
    blast.d3Symbols.length === 0 &&
    blast.affectedModules.length === 0 &&
    blast.riskFiles.length === 0
  );
}

function hasBlastRadius(blast: BlastResult): boolean {
  return (
    blast.d1Symbols.length > 0 || blast.d2Symbols.length > 0 || blast.d3Symbols.length > 0
  );
}

function renderArchitectureImpact(modules: AffectedModule[], detail: DetailLevel): string {
  const cap = detail === 'capped' || detail === 'minimal' ? TOP_N_MODULE_ROWS : modules.length;
  const sorted = [...modules].sort((a, b) => b.hits - a.hits);
  const shown = sorted.slice(0, cap);
  const rows: string[] = [];
  rows.push('### Architecture Impact');
  rows.push('');
  rows.push('| Module | Hits | Direct |');
  rows.push('|---|---|---|');
  for (const m of shown) {
    rows.push(`| \`${escapeCell(m.name)}\` | ${m.hits} | ${m.direct ? 'yes' : 'no'} |`);
  }
  if (sorted.length > shown.length) {
    rows.push('');
    rows.push(`_(${sorted.length - shown.length} more module${sorted.length - shown.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

function renderBlastRadius(blast: BlastResult, detail: DetailLevel): string {
  const rows: string[] = [];
  rows.push('### Blast Radius');
  rows.push('');
  rows.push('| Depth | Count |');
  rows.push('|---|---|');
  rows.push(`| d1 (direct)     | ${blast.d1Symbols.length} |`);
  rows.push(`| d2 (indirect)   | ${blast.d2Symbols.length} |`);
  rows.push(`| d3 (transitive) | ${blast.d3Symbols.length} |`);

  if (detail === 'full') {
    appendDetails(rows, 'Direct dependents (d1)', blast.d1Symbols);
    appendDetails(rows, 'Indirect dependents (d2)', blast.d2Symbols);
    appendDetails(rows, 'Transitive dependents (d3)', blast.d3Symbols);
  }
  return rows.join('\n');
}

function appendDetails(rows: string[], summary: string, symbols: SymbolRef[]): void {
  if (symbols.length === 0) return;
  const top = symbols.slice(0, TOP_N_BLAST_LIST);
  rows.push('');
  rows.push(`<details><summary>${summary}</summary>`);
  rows.push('');
  for (const s of top) {
    const loc = formatLocation(s);
    rows.push(`- ${loc} — \`${escapeCell(s.name)}\``);
  }
  if (symbols.length > top.length) {
    rows.push(`- _(${symbols.length - top.length} more)_`);
  }
  rows.push('');
  rows.push('</details>');
}

function renderSymbolChanges(symbols: SymbolRef[], detail: DetailLevel): string {
  const cap =
    detail === 'capped' ? TOP_N_SYMBOL_ROWS : detail === 'minimal' ? 10 : symbols.length;
  const shown = symbols.slice(0, cap);
  const rows: string[] = [];
  rows.push('### Symbol Changes');
  rows.push('');
  rows.push('| Kind | Symbol | Location |');
  rows.push('|---|---|---|');
  for (const s of shown) {
    rows.push(
      `| ${escapeCell(s.type)} | \`${escapeCell(s.name)}\` | ${formatLocation(s)} |`,
    );
  }
  if (symbols.length > shown.length) {
    rows.push('');
    rows.push(`_(${symbols.length - shown.length} more symbol${symbols.length - shown.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

/**
 * @brief: Project changed symbols onto the API-surface subset. v1 has no
 *         `change` field in the Hub response (the `pr_blast_results` shape
 *         lacks per-symbol diff classification) so the projection is purely
 *         a type-based filter: routes and exported declarations.
 */
function projectApiSurface(symbols: SymbolRef[]): SymbolRef[] {
  const surfaceTypes = new Set(['Route', 'Export']);
  return symbols.filter((s) => surfaceTypes.has(s.type));
}

function renderApiSurfaceDelta(symbols: SymbolRef[]): string {
  const rows: string[] = [];
  rows.push('### API Surface Delta');
  rows.push('');
  rows.push('| Kind | Symbol | Location |');
  rows.push('|---|---|---|');
  for (const s of symbols) {
    rows.push(
      `| ${escapeCell(s.type)} | \`${escapeCell(s.name)}\` | ${formatLocation(s)} |`,
    );
  }
  return rows.join('\n');
}

function renderRiskFiles(riskFiles: RiskFile[]): string {
  const top = riskFiles.slice(0, TOP_N_RISK_FILES);
  const rows: string[] = [];
  rows.push('### File Risk');
  rows.push('');
  rows.push('| File | Risk | Status | Category |');
  rows.push('|---|---|---|---|');
  for (const f of top) {
    rows.push(
      `| \`${escapeCell(f.path)}\` | ${f.risk} | ${escapeCell(f.status)} | ${escapeCell(f.category ?? '')} |`,
    );
  }
  if (riskFiles.length > top.length) {
    rows.push('');
    rows.push(`_(${riskFiles.length - top.length} more file${riskFiles.length - top.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

function appendFooter(
  parts: string[],
  blast: BlastResult,
  hubUrl: string,
  truncated: boolean,
): void {
  parts.push('---');
  const bits: string[] = [];
  bits.push(`blast level \`${blast.blastLevel}\``);
  if (blast.fileRiskLevel) bits.push(`file risk \`${blast.fileRiskLevel}\``);
  bits.push(`computed \`${blast.computedAt}\``);
  bits.push(`[GitNexus Hub](${hubUrl})`);
  parts.push(`_${bits.join(' · ')}_`);
  if (truncated) {
    parts.push('');
    parts.push('_Comment truncated — full results on the Hub._');
  }
}

/**
 * @brief: Format a SymbolRef location as `path:line` markdown code, with
 *         the line suffix dropped when the symbol is file-level (the Hub
 *         emits `startLine: null` for file-class entries).
 */
function formatLocation(symbol: SymbolRef): string {
  const line = symbol.startLine;
  const safePath = escapeCell(symbol.filePath);
  return line == null ? `\`${safePath}\`` : `\`${safePath}:${line}\``;
}

/**
 * @brief: Defensively escape characters that would break a markdown table
 *         cell. The Hub-supplied strings (file paths, symbol names,
 *         module names) are untrusted-input-ish in the security-model
 *         sense — they come from the user's own repo but flow through our
 *         renderer; we treat them conservatively.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
