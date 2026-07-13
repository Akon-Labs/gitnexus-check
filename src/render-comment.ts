/**
 * @brief: Pure markdown renderer for the PR comment body. Consumes a
 *         normalised BlastResult (post-isBlastResult, post-normalize) and
 *         emits a single string under CHAR_BUDGET. Performs progressive
 *         truncation when over budget per v1-integration-plan.md §8. No
 *         I/O, no `core.*`, no axios - this module is deterministic and
 *         fully fixture-testable.
 */

import type {
  AffectedFlow,
  AffectedModule,
  BlastLevel,
  BlastResult,
  ChangedFile,
  CrossRepoFinding,
  CrossRepoGroup,
  CrossRepoResult,
  FlowCrossRepoFinding,
  RiskFile,
  SymbolCrossRepoFinding,
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

/**
 * @brief: Embeddable (raw) URL for the Akon Labs logo in the comment header.
 *         The comment lands in the *consumer's* repo, so a relative path
 *         would not resolve. Must be a raw URL (not a /blob/ page URL) so it
 *         renders inside an <img>; pinned to the public `release` branch.
 */
const LOGO_URL =
  'https://raw.githubusercontent.com/Akon-Labs/gitnexus-check/release/.github/assets/akonlabs-logo.png';

const TOP_N_BLAST_LIST = 20;
const TOP_N_MODULE_ROWS = 20;
const TOP_N_SYMBOL_ROWS = 50;
const TOP_N_RISK_FILES = 20;
const TOP_N_FLOW_ROWS = 20;
const TOP_N_FILE_ROWS = 20;

/** Max cross-repo findings rendered before a "(N more)" trailer. */
const TOP_N_CROSS_REPO = 15;
/** Per-consumer-repo finding cap applied at the `capped` truncation level. */
const CROSS_REPO_CAPPED_PER_REPO = 3;

/**
 * Display channels for cross-repo findings, in render order. Each finding is
 * sorted into one of these so a consumer repo's dependencies read as a few
 * labelled groups instead of a flat list of near-identical bullets.
 */
const CROSS_REPO_CHANNEL_ORDER = [
  'Imported symbols',
  'HTTP routes',
  'Messaging topics',
  'Contracts',
  'Shared flows',
] as const;

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
 * @returns: string - markdown body ≤ CHAR_BUDGET.
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
  // Even the headline variant blew the budget - clamp hard.
  return variants[variants.length - 1]().slice(0, CHAR_BUDGET);
}

type DetailLevel = 'full' | 'no-details' | 'capped' | 'minimal' | 'headline-only';

/**
 * @brief: Build the comment body at a given detail level. Internal - the
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
  parts.push(renderHeader(opts.prNumber));
  parts.push('');

  const headline = buildHeadline(blast);
  if (headline) {
    parts.push(`> ${levelEmoji(blast.blastLevel)} ${headline}`);
    parts.push('');
  }

  if (cfg.detailLevel === 'headline-only') {
    return parts.join('\n');
  }

  if (isEmptyBlast(blast)) {
    parts.push(
      'No symbol changes, blast radius, architecture impact, or API surface changes detected.',
    );
    parts.push('');
    // Docs-only / config-only PRs carry changedFiles but no blast signal.
    // Still surface the file list so the comment isn't content-free.
    if (blast.changedFiles.length > 0) {
      parts.push(
        detailsBlock(
          `Changed Files (${blast.changedFiles.length})`,
          renderChangedFiles(blast.changedFiles, cfg.detailLevel),
        ),
      );
      parts.push('');
    }
    return parts.join('\n');
  }

  parts.push(renderSummaryStrip(blast));
  parts.push('');
  parts.push('---');
  parts.push('');

  const renderedAny = appendSections(parts, blast, cfg.detailLevel);
  if (!renderedAny) {
    parts.push(
      'No symbol changes, blast radius, architecture impact, or API surface changes detected.',
    );
    parts.push('');
  }

  const recommendations = renderRecommendations(blast);
  if (recommendations) {
    parts.push(recommendations);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * @brief: Centered header block with the review title.
 *
 * @params: (prNumber: number) -> GitHub PR number for the title.
 * @returns: string - an HTML-centered markdown block.
 */
function renderHeader(prNumber: number): string {
  return [
    '<div align="center">',
    '',
    `<img src="${LOGO_URL}" alt="Akon Labs" width="88" />`,
    '',
    `### GitNexus Review · PR #${prNumber}`,
    '',
    '</div>',
  ].join('\n');
}

/**
 * @brief: At-a-glance metrics strip rendered just under the verdict - a
 *         one-row table of the headline numbers (level, dependents,
 *         modules, flows, files) so a reviewer can scan impact instantly.
 *
 * @params: (blast: BlastResult) -> Normalised Hub result.
 * @returns: string - a single-row markdown table.
 */
function renderSummaryStrip(blast: BlastResult): string {
  const deps = blast.d1Symbols.length + blast.d2Symbols.length + blast.d3Symbols.length;
  return [
    '| Blast Level | Dependents | Modules | Flows | Files |',
    '|:--:|:--:|:--:|:--:|:--:|',
    `| ${levelEmoji(blast.blastLevel)} \`${blast.blastLevel}\` | ${deps} | ${blast.affectedModules.length} | ${blast.affectedFlows.length} | ${blast.changedFiles.length} |`,
  ].join('\n');
}

/**
 * @brief: Render the signal sections grouped into three reviewer-intent
 *         buckets - "What changed" (the PR's own edits), "What it affects"
 *         (downstream impact), and "What to check" (risk/follow-ups). Each
 *         bucket header is emitted only when it has at least one section.
 *         Long lists (Symbol Changes, Changed Files, Affected Flows, File
 *         Risk) are wrapped in collapsible <details> so the comment reads
 *         as a review rather than a flat dump. Returns true if any bucket
 *         rendered, so the caller can fall back to the "no impact" sentence.
 */
function appendSections(
  parts: string[],
  blast: BlastResult,
  detail: DetailLevel,
): boolean {
  let rendered = false;

  // ── What changed: the PR's own edits ──
  const changed: string[] = [];
  if (detail !== 'minimal' && blast.changedSymbols.length > 0) {
    changed.push(
      detailsBlock(
        `Symbol Changes (${blast.changedSymbols.length})`,
        renderSymbolChanges(blast.changedSymbols, detail),
      ),
    );
  }
  if (detail !== 'minimal' && blast.changedFiles.length > 0) {
    changed.push(
      detailsBlock(
        `Changed Files (${blast.changedFiles.length})`,
        renderChangedFiles(blast.changedFiles, detail),
      ),
    );
  }
  rendered = appendBucket(parts, 'What changed', changed) || rendered;

  // ── What it affects: downstream impact ──
  const affects: string[] = [];
  if (blast.affectedModules.length > 0) {
    affects.push(renderArchitectureImpact(blast.affectedModules, detail));
  }
  if (detail !== 'minimal' && blast.affectedFlows.length > 0) {
    affects.push(
      detailsBlock(
        `Affected Flows (${blast.affectedFlows.length})`,
        renderAffectedFlows(blast.affectedFlows, detail),
      ),
    );
  }
  if (detail !== 'minimal' && hasBlastRadius(blast)) {
    affects.push(renderBlastRadius(blast, detail));
  }
  if (detail !== 'minimal' && detail !== 'capped') {
    const surface = projectApiSurface(blast.changedSymbols);
    if (surface.length > 0) affects.push(renderApiSurfaceDelta(surface));
  }
  rendered = appendBucket(parts, 'What it affects', affects) || rendered;

  // ── Cross-repo impact: reach into the org's other repos ──
  // Renders when there are findings OR an error (silence reads as "no impact",
  // so a failed bridge join must still be visible). Dropped at minimal /
  // headline-only; per-repo capped at `capped`. Cross-repo outranks d2/d3
  // transitive detail but never the headline.
  if (detail !== 'minimal') {
    const cr = blast.crossRepo;
    if (
      cr &&
      (cr.findings.length > 0 || cr.error !== null || (cr.notYetKnowable?.length ?? 0) > 0)
    ) {
      const section = renderCrossRepo(cr, detail);
      if (section) rendered = appendBucket(parts, 'Cross-Repo Impact', [section]) || rendered;
    }
  }

  // ── What to check: risk / follow-ups ──
  const check: string[] = [];
  if (detail === 'full' && blast.riskFiles.length > 0) {
    check.push(
      detailsBlock(`File Risk (${blast.riskFiles.length})`, renderRiskFiles(blast.riskFiles)),
    );
  }
  rendered = appendBucket(parts, 'What to check', check) || rendered;

  return rendered;
}

/**
 * @brief: Emit a `## <title>` bucket and its sections, but only when the
 *         bucket has at least one section. Returns whether anything was
 *         emitted so the caller can track overall rendered state.
 */
function appendBucket(parts: string[], title: string, sections: string[]): boolean {
  if (sections.length === 0) return false;
  parts.push(`## ${title}`);
  parts.push('');
  for (const section of sections) {
    parts.push(section);
    parts.push('');
  }
  return true;
}

/**
 * @brief: Render the Cross-Repo Impact bucket body. Opens with one plain-English
 *         sentence explaining what cross-repo impact means, then a subsection per
 *         consumer repo whose findings are grouped into labelled channels (HTTP
 *         routes, messaging topics, imported symbols, …) so the section reads as
 *         a scannable map rather than a flat dump. Closes with freshness /
 *         degraded notes. Hub order is preserved (the Hub confidence-sorts; the
 *         Action never re-sorts). All interpolated Hub strings pass through
 *         escapeCell. Returns '' if nothing renders.
 *
 * @params: (cr: CrossRepoResult) -> The normalised cross-repo envelope.
 * @params: (detail: DetailLevel) -> Drives the per-repo cap at `capped`.
 */
function renderCrossRepo(cr: CrossRepoResult, detail: DetailLevel): string {
  // Group by consumer repo, preserving Hub order, capped at TOP_N_CROSS_REPO.
  const order: string[] = [];
  const byRepo = new Map<string, CrossRepoFinding[]>();
  let shown = 0;
  for (const f of cr.findings) {
    if (shown >= TOP_N_CROSS_REPO) break;
    // Flow findings carry consumerRepo '' (they span repos); bucket them under
    // a named header so they don't collapse into a blank-named group.
    const key = f.consumerRepo && f.consumerRepo.length > 0 ? f.consumerRepo : 'Shared cross-repo flows';
    const existing = byRepo.get(key);
    if (existing) {
      existing.push(f);
    } else {
      byRepo.set(key, [f]);
      order.push(key);
    }
    shown++;
  }

  const perRepoCap = detail === 'capped' ? CROSS_REPO_CAPPED_PER_REPO : Number.POSITIVE_INFINITY;
  const lines: string[] = [];

  // One plain sentence so a reviewer knows what this section means, then a
  // collapsed block per consumer repo so the comment stays short by default.
  lines.push(
    '> Repos in your group that depend on code this PR changes. Expand each to see what it relies on, and review before merging.',
  );
  lines.push('');

  for (const repo of order) {
    const findings = byRepo.get(repo) ?? [];
    const visible = findings.slice(0, perRepoCap);
    const noun = findings.length === 1 ? 'interface' : 'interfaces';
    const channelLines = renderConsumerChannels(visible, detail);
    const hidden = findings.length - visible.length;
    if (hidden > 0) channelLines.push(`_…and ${hidden} more in this repo._`);
    const inner = channelLines.join('\n').trimEnd();
    lines.push(detailsBlock(`${escapeCell(repo)} · ${findings.length} ${noun}`, inner));
    lines.push('');
  }

  const remaining = cr.findings.length - shown;
  if (remaining > 0) {
    lines.push(`_${remaining} further cross-repo finding${remaining === 1 ? '' : 's'} not shown._`);
    lines.push('');
  }

  const staleDate = oldestStaleDate(cr.groups);
  if (staleDate) {
    lines.push(
      `_Based on a cross-repo analysis from ${staleDate}. Re-analyze the group for up-to-date results._`,
    );
  }
  // Privacy: never echo the raw Hub error (it can carry a group name, §5.2). The
  // pre-lines / pending-rebuild caveats arrive on `cr.error` and render through
  // this same generic degraded note (their wording never reaches the comment).
  if (cr.error !== null) {
    lines.push('_Cross-repo analysis was incomplete, so some dependents may be missing._');
  }
  // New-in-PR exports have no cross-repo edge yet — surface an explicit caveat
  // (count only) so silence isn't misread as "no downstream impact".
  const notYetKnowable = cr.notYetKnowable?.length ?? 0;
  if (notYetKnowable > 0) {
    const plural = notYetKnowable === 1 ? '' : 's';
    const verb = notYetKnowable === 1 ? 'is' : 'are';
    lines.push(
      `_${notYetKnowable} changed symbol${plural} ${verb} new in this PR — cross-repo impact not yet knowable._`,
    );
  }

  return lines.join('\n').trimEnd();
}

/**
 * @brief: Group a consumer repo's findings into labelled channels (HTTP routes,
 *         messaging topics, imported symbols, …) and render each as a compact
 *         block: a single comma-separated line for interface-style channels, a
 *         short bullet list for the symbol/flow channels that carry a location.
 *         This turns a flat dump of near-identical bullets into a scannable map
 *         of "what kind of thing, and how many".
 */
function renderConsumerChannels(findings: CrossRepoFinding[], detail: DetailLevel): string[] {
  const inlineItems = new Map<string, string[]>();
  const bulletItems = new Map<string, string[]>();
  for (const f of findings) {
    const c = categorizeFinding(f, detail);
    if (!c) continue;
    const bucket = c.style === 'inline' ? inlineItems : bulletItems;
    const list = bucket.get(c.channel);
    if (list) list.push(c.display);
    else bucket.set(c.channel, [c.display]);
  }

  const out: string[] = [];
  for (const channel of CROSS_REPO_CHANNEL_ORDER) {
    // A channel can carry BOTH styles (e.g. repo-level HTTP contracts inline +
    // sym→sym HTTP edges as located bullets). Single-style channels keep their
    // historical rendering byte-identically; a mixed channel renders ONE
    // header with the combined count (two headers whose counts don't sum read
    // as a bug), folding the inline entries in as leading bullets.
    const inline = inlineItems.get(channel) ?? [];
    const bullets = bulletItems.get(channel) ?? [];
    const total = inline.length + bullets.length;
    if (total === 0) continue;
    if (bullets.length === 0) {
      out.push(`**${channel}** (${total}): ${inline.join(', ')}`);
    } else {
      out.push(`**${channel}** (${total}):`);
      for (const i of inline) out.push(`- ${i}`);
      for (const b of bullets) out.push(`- ${b}`);
    }
    out.push('');
  }
  return out;
}

/**
 * @brief: Sort one finding into a display channel. Discriminated-union switch on
 *         `kind` with a default of `null` (skip), so an unknown future kind (the
 *         reserved 'breakage') is ignored rather than mis-rendered. Contract
 *         `via` values carry a `http:` / `messaging:` prefix that names the
 *         channel, so we strip it from the display once the channel is set.
 *         A sym→sym edge whose provider is an HTTP route (providerContract.kind
 *         'http', or a `via` starting `http:`) routes into the "HTTP routes"
 *         channel as a located bullet — the coupled route plus the consumer's
 *         call sites — instead of the generic "Imported symbols" channel; other
 *         symbol edges are unchanged. Every interpolated value is escaped for a
 *         markdown table/code cell.
 */
function categorizeFinding(
  f: CrossRepoFinding,
  detail: DetailLevel,
): { channel: string; display: string; style: 'inline' | 'bullet' } | null {
  switch (f.kind) {
    case 'symbol': {
      if (isHttpSymbolFinding(f)) {
        return {
          channel: 'HTTP routes',
          display: `\`${escapeCell(httpContractLabel(f))}\`${renderCallSites(f, detail)}`,
          style: 'bullet',
        };
      }
      const base = f.consumerSymbol
        ? `\`${escapeCell(f.consumerSymbol.name)}\` (used in \`${escapeCell(consumerLoc(f.consumerSymbol))}\`)`
        : `\`${escapeCell(f.via)}\``;
      return {
        channel: 'Imported symbols',
        display: `${base}${renderCallSites(f, detail)}`,
        style: 'bullet',
      };
    }
    case 'contract': {
      if (f.via.startsWith('http:')) {
        return { channel: 'HTTP routes', display: `\`${escapeCell(f.via.slice(5))}\``, style: 'inline' };
      }
      if (f.via.startsWith('messaging:')) {
        return { channel: 'Messaging topics', display: `\`${escapeCell(f.via.slice(10))}\``, style: 'inline' };
      }
      return { channel: 'Contracts', display: `\`${escapeCell(f.via)}\``, style: 'inline' };
    }
    case 'flow': {
      // Malformed payloads reach here via the shallow trust-boundary cast, so
      // `flow` may be absent/partial. Never deref it unguarded — renderComment
      // runs outside a try/catch in main.ts, so a throw here would setFailed the
      // whole check. Fall back to `via` (then a placeholder) and drop the step
      // clause when the counters aren't both numbers.
      const flow = (f as { flow?: FlowCrossRepoFinding['flow'] }).flow;
      const label =
        flow && typeof flow.label === 'string' && flow.label.length > 0
          ? flow.label
          : typeof f.via === 'string' && f.via.length > 0
            ? f.via
            : 'cross-repo flow';
      const display =
        flow && typeof flow.step === 'number' && typeof flow.stepCount === 'number'
          ? `\`${escapeCell(label)}\` (step ${flow.step} of ${flow.stepCount})`
          : `\`${escapeCell(label)}\``;
      return { channel: 'Shared flows', display, style: 'bullet' };
    }
    default:
      return null;
  }
}

/** True when a symbol edge's provider is an HTTP route (contract kind or via prefix). */
function isHttpSymbolFinding(f: SymbolCrossRepoFinding): boolean {
  return (
    f.providerContract?.kind === 'http' ||
    (typeof f.via === 'string' && f.via.startsWith('http:'))
  );
}

/**
 * @brief: The coupled HTTP route label for a sym→sym HTTP edge — `METHOD path`
 *         from `providerContract` when present, else the `http:`-stripped `via`,
 *         else the raw `via`. Returned unescaped; the caller escapes it.
 */
function httpContractLabel(f: SymbolCrossRepoFinding): string {
  const pc = f.providerContract;
  if (pc) {
    const parts = [pc.method, pc.path].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    if (parts.length > 0) return parts.join(' ');
  }
  if (typeof f.via === 'string' && f.via.startsWith('http:')) return f.via.slice(5);
  return typeof f.via === 'string' ? f.via : '';
}

/** `filePath:line` for a consumer symbol, dropping the suffix when no line. */
function consumerLoc(cs: { filePath: string; startLine?: number | null }): string {
  return typeof cs.startLine === 'number' ? `${cs.filePath}:${cs.startLine}` : cs.filePath;
}

/**
 * @brief: Render a symbol finding's consumer call sites as a compact
 *         `— \`file:line\`, …` suffix, each path run through the same
 *         `escapeCell` the renderer applies to every Hub path. Extra detail, so
 *         it drops at the `capped`/`minimal` ladder levels (the route/symbol
 *         summary survives, the call-site list is what degrades). When
 *         `consumerD1Count` exceeds the rendered sites, a `(+N more)` tail
 *         reports the full direct-caller count. Returns '' when there is
 *         nothing well-formed to show.
 */
function renderCallSites(f: SymbolCrossRepoFinding, detail: DetailLevel): string {
  if (detail === 'capped' || detail === 'minimal' || detail === 'headline-only') return '';
  const sites = Array.isArray(f.callSites) ? f.callSites.filter(isCallSite) : [];
  if (sites.length === 0) return '';
  const rendered = sites.map((s) => `\`${escapeCell(s.filePath)}:${s.startLine}\``).join(', ');
  const total = typeof f.consumerD1Count === 'number' ? f.consumerD1Count : sites.length;
  const more = total > sites.length ? ` (+${total - sites.length} more)` : '';
  return ` — called from ${rendered}${more}`;
}

/**
 * Runtime guard for a well-formed call site off the shallow-validated
 * envelope. Requires a POSITIVE finite line — the Hub coerces unknown lines
 * to 0, and rendering `file.ts:0` would be an invalid, misleading reference.
 */
function isCallSite(s: unknown): s is { filePath: string; startLine: number } {
  if (typeof s !== 'object' || s === null) return false;
  const { filePath, startLine } = s as { filePath?: unknown; startLine?: unknown };
  return (
    typeof filePath === 'string' &&
    filePath.length > 0 &&
    typeof startLine === 'number' &&
    Number.isFinite(startLine) &&
    startLine > 0
  );
}

/** Distinct, non-empty consumer repos in Hub-emit order (for the verdict clause). */
function distinctConsumerRepos(findings: CrossRepoFinding[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of findings) {
    if (f.consumerRepo && !seen.has(f.consumerRepo)) {
      seen.add(f.consumerRepo);
      out.push(f.consumerRepo);
    }
  }
  return out;
}

/** Oldest `lastAnalyzedAt` among stale groups as YYYY-MM-DD, or null if none stale. */
function oldestStaleDate(groups: CrossRepoGroup[]): string | null {
  const dates = groups
    .filter((g) => g.stale && typeof g.lastAnalyzedAt === 'string')
    .map((g) => g.lastAnalyzedAt as string)
    .sort();
  return dates.length > 0 ? dates[0].slice(0, 10) : null;
}

/**
 * @brief: The Verdict - a deterministic single-line ruling for the
 *         blockquote at the top, derived solely from already-validated
 *         numeric/enum fields (never untrusted PR title/branch strings).
 *         Combines the blast-level ruling, total dependent count, module
 *         count, a flow addendum when flows are present, a level-based
 *         rationale clause for MEDIUM/HIGH/CRITICAL (LOW emits none), and
 *         the stale marker. Returns '' when there is nothing to summarise
 *         so the renderer can suppress the blockquote.
 *
 * @params: (blast: BlastResult) -> Normalised Hub result.
 *
 * @returns: string - the one-line verdict, or '' when empty.
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
  const flows = blast.affectedFlows.length;
  if (flows > 0) bits.push(`${flows} flow${flows === 1 ? '' : 's'} affected`);
  const rationale = levelRationale(blast.blastLevel);
  if (rationale) bits.push(rationale);

  // Cross-repo verdict clause: "affects N other repos (a, b, c +K more)".
  const cr = blast.crossRepo;
  if (cr && cr.findings.length > 0) {
    const repos = distinctConsumerRepos(cr.findings);
    if (repos.length > 0) {
      const head = repos.slice(0, 3).map(escapeCell).join(', ');
      const extra = repos.length > 3 ? ` +${repos.length - 3} more` : '';
      bits.push(`affects ${repos.length} other repo${repos.length === 1 ? '' : 's'} (${head}${extra})`);
    }
  }

  if (blast.stale) bits.push('_(stale, re-run for fresh analysis)_');
  // Distinct cross-repo caveats (error and stale are different states).
  if (cr && cr.error !== null) {
    bits.push('_(cross-repo analysis unavailable)_');
  } else if (cr && cr.groups.some((g) => g.stale)) {
    bits.push('_(cross-repo data may be stale)_');
  }
  return bits.join(' · ');
}

/**
 * @brief: Short parenthetical rationale for the verdict, keyed off the
 *         blast level. LOW returns '' (no clause); MEDIUM/HIGH/CRITICAL
 *         return a fixed `_(...)_` reason.
 */
function levelRationale(level: BlastLevel): string {
  switch (level) {
    case 'CRITICAL':
      return '_(critical surface, review carefully before merge)_';
    case 'HIGH':
      return '_(high reach, verify dependents)_';
    case 'MEDIUM':
      return '_(moderate reach, spot-check dependents)_';
    default:
      return '';
  }
}

/** Traffic-light emoji for a blast/risk level. */
function levelEmoji(level: BlastLevel): string {
  switch (level) {
    case 'CRITICAL':
      return '🔴';
    case 'HIGH':
      return '🟠';
    case 'MEDIUM':
      return '🟡';
    default:
      return '🟢';
  }
}

/** Emoji-prefixed, escaped change-status cell (added/modified/removed/renamed). */
function statusBadge(status: string): string {
  const e =
    status === 'added'
      ? '🟢'
      : status === 'modified'
        ? '🟡'
        : status === 'removed'
          ? '🔴'
          : status === 'renamed'
            ? '🔵'
            : '⚪';
  return `${e} ${escapeCell(status)}`;
}

/** Emoji-prefixed, escaped file-risk cell. */
function riskBadge(risk: BlastLevel): string {
  return `${levelEmoji(risk)} ${escapeCell(risk)}`;
}

/** Wrap inner markdown in a collapsible <details> with a bold summary. */
function detailsBlock(summary: string, inner: string): string {
  return ['<details>', `<summary><b>${summary}</b></summary>`, '', inner, '', '</details>'].join(
    '\n',
  );
}

function isEmptyBlast(blast: BlastResult): boolean {
  return (
    blast.changedSymbols.length === 0 &&
    blast.d1Symbols.length === 0 &&
    blast.d2Symbols.length === 0 &&
    blast.d3Symbols.length === 0 &&
    blast.affectedModules.length === 0 &&
    blast.affectedFlows.length === 0 &&
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
  rows.push('|---|--:|:--:|');
  for (const m of shown) {
    rows.push(`| \`${escapeCell(m.name)}\` | ${m.hits} | ${m.direct ? '🟢' : '⚪'} |`);
  }
  if (sorted.length > shown.length) {
    rows.push('');
    rows.push(`_(${sorted.length - shown.length} more module${sorted.length - shown.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

/**
 * @brief: Render the Affected Flows table (`| Process | Hits |`), sorted by
 *         hitCount descending when present. Each flow's display name is the
 *         first defined string of processName, name, or processId, falling
 *         back to '(unnamed flow)'; every Hub string is run through
 *         escapeCell (§6.1). Rows are capped at TOP_N_FLOW_ROWS at the
 *         capped detail level with a `_(N more)_` trailer. No section
 *         header - the caller wraps it in a collapsible block.
 */
function renderAffectedFlows(flows: AffectedFlow[], detail: DetailLevel): string {
  const cap = detail === 'capped' ? TOP_N_FLOW_ROWS : flows.length;
  const sorted = [...flows].sort((a, b) => flowHits(b) - flowHits(a));
  const shown = sorted.slice(0, cap);
  const rows: string[] = [];
  rows.push('| Process | Hits |');
  rows.push('|---|--:|');
  for (const f of shown) {
    const hits = typeof f.hitCount === 'number' ? String(f.hitCount) : 'n/a';
    rows.push(`| ${escapeCell(flowName(f))} | ${hits} |`);
  }
  if (sorted.length > shown.length) {
    rows.push('');
    rows.push(`_(${sorted.length - shown.length} more flow${sorted.length - shown.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

/** Narrow the flow's display name without `as`; fall back to a placeholder. */
function flowName(flow: AffectedFlow): string {
  if (typeof flow.processName === 'string' && flow.processName) return flow.processName;
  if (typeof flow.name === 'string' && flow.name) return flow.name;
  if (typeof flow.processId === 'string' && flow.processId) return flow.processId;
  return '(unnamed flow)';
}

/** Numeric hit count for sorting; absent/non-numeric sorts last as 0. */
function flowHits(flow: AffectedFlow): number {
  return typeof flow.hitCount === 'number' ? flow.hitCount : 0;
}

/**
 * @brief: Render the Changed Files table (`| File | Status |`). The path is
 *         emitted through escapeCell (§6.1) as an untrusted repo string and
 *         the status as an emoji-prefixed badge. Rows are capped at
 *         TOP_N_FILE_ROWS at the capped detail level with a `_(N more)_`
 *         trailer. The caller wraps the result in a collapsible block.
 */
function renderChangedFiles(files: ChangedFile[], detail: DetailLevel): string {
  const cap = detail === 'capped' ? TOP_N_FILE_ROWS : files.length;
  const shown = files.slice(0, cap);
  const rows: string[] = [];
  rows.push('| File | Status |');
  rows.push('|---|:--|');
  for (const f of shown) {
    rows.push(`| \`${escapeCell(f.path)}\` | ${statusBadge(f.status)} |`);
  }
  if (files.length > shown.length) {
    rows.push('');
    rows.push(`_(${files.length - shown.length} more file${files.length - shown.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

function renderBlastRadius(blast: BlastResult, detail: DetailLevel): string {
  const rows: string[] = [];
  rows.push('### Blast Radius');
  rows.push('');
  rows.push('| Depth | Count |');
  rows.push('|---|--:|');
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
    rows.push(`- ${loc} · \`${escapeCell(s.name)}\``);
  }
  if (symbols.length > top.length) {
    rows.push(`- _(${symbols.length - top.length} more)_`);
  }
  rows.push('');
  rows.push('</details>');
}

/**
 * @brief: Render the Symbol Changes table (`| Kind | Symbol | Location |`).
 *         No section header - the caller wraps it in a collapsible block
 *         whose summary carries the count. Capped per detail level.
 */
function renderSymbolChanges(symbols: SymbolRef[], detail: DetailLevel): string {
  const cap =
    detail === 'capped' ? TOP_N_SYMBOL_ROWS : detail === 'minimal' ? 10 : symbols.length;
  const shown = symbols.slice(0, cap);
  const rows: string[] = [];
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

/**
 * @brief: Render the File Risk table. No section header - the caller wraps
 *         it in a collapsible block. Risk and status render as
 *         emoji-prefixed badges; all Hub strings pass through escapeCell.
 */
function renderRiskFiles(riskFiles: RiskFile[]): string {
  const top = riskFiles.slice(0, TOP_N_RISK_FILES);
  const rows: string[] = [];
  rows.push('| File | Risk | Status | Category |');
  rows.push('|---|:--|:--|---|');
  for (const f of top) {
    rows.push(
      `| \`${escapeCell(f.path)}\` | ${riskBadge(f.risk)} | ${statusBadge(f.status)} | ${escapeCell(f.category ?? '')} |`,
    );
  }
  if (riskFiles.length > top.length) {
    rows.push('');
    rows.push(`_(${riskFiles.length - top.length} more file${riskFiles.length - top.length === 1 ? '' : 's'})_`);
  }
  return rows.join('\n');
}

/**
 * @brief: Deterministic, no-LLM guidance for shrinking the blast radius,
 *         shown for any elevated PR (MEDIUM and above; LOW is skipped).
 *         Each bullet is gated on a threshold over data already in the
 *         comment (direct dependents, modules spanned, flows reached, the
 *         hottest changed file, risky non-code files, PR size); the section
 *         is omitted entirely when no rule fires. Bullets are capped so the
 *         section stays actionable, not another dump. Returns '' when there
 *         is nothing to recommend.
 *
 * @params: (blast: BlastResult) -> Normalised Hub result.
 * @returns: string - the markdown section, or '' when not applicable.
 */
function renderRecommendations(blast: BlastResult): string {
  if (blast.blastLevel === 'LOW') return '';
  const tips: string[] = [];

  const d1 = blast.d1Symbols.length;
  if (d1 >= 15) {
    tips.push(
      `**${d1} direct dependents.** The changed symbols are widely called, so keep changes backwards-compatible (additive over breaking). If a signature must change, add a thin wrapper that preserves the old one so callers don't all need updating in this PR.`,
    );
  }

  const moduleCount = blast.affectedModules.length;
  const directModules = blast.affectedModules.filter((m) => m.direct).length;
  if (moduleCount >= 3 || directModules >= 2) {
    tips.push(
      `**Spans ${moduleCount} module${moduleCount === 1 ? '' : 's'}.** Consider splitting this PR along module lines so each change reviews and ships with a contained blast radius.`,
    );
  }

  const flows = blast.affectedFlows.length;
  if (flows >= 5) {
    tips.push(
      `**Reaches ${flows} execution flows.** Gate the change behind a feature flag or stage the rollout so a regression can't hit every flow at once.`,
    );
  }

  const hot = hottestFile(blast.changedSymbols);
  if (hot && hot.count >= 8) {
    tips.push(
      `**\`${escapeCell(hot.path)}\` concentrates ${hot.count} changed symbols.** Splitting this file (or carving it out of this PR) shrinks how much one change can break.`,
    );
  }

  const risky = blast.riskFiles.filter((f) => f.risk === 'HIGH' || f.risk === 'CRITICAL');
  if (risky.length > 0) {
    const names = risky.slice(0, 3).map((f) => `\`${escapeCell(f.path)}\``).join(', ');
    tips.push(
      `**Also changes ${risky.length} high-risk file${risky.length === 1 ? '' : 's'}** (${names}). Move migration/CI/infra changes into a separate PR so a logic bug can't block them, and vice versa.`,
    );
  }

  if (blast.changedFiles.length >= 40) {
    tips.push(
      `**Large PR (${blast.changedFiles.length} files).** Smaller, focused PRs review faster and carry a narrower blast radius.`,
    );
  }

  if (tips.length === 0) return '';
  const rows: string[] = [];
  rows.push('## How to reduce the blast radius');
  rows.push('');
  for (const tip of tips.slice(0, 4)) rows.push(`- ${tip}`);
  return rows.join('\n');
}

/**
 * @brief: The changed-symbol file with the most entries, for the hot-file
 *         recommendation. Returns null when there are no changed symbols.
 */
function hottestFile(symbols: SymbolRef[]): { path: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const s of symbols) counts.set(s.filePath, (counts.get(s.filePath) ?? 0) + 1);
  let best: { path: string; count: number } | null = null;
  for (const [path, count] of counts) {
    if (best === null || count > best.count) best = { path, count };
  }
  return best;
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
 *         cell or inline code span. The Hub-supplied strings (file paths,
 *         symbol names, module names) are untrusted-input-ish in the
 *         security-model sense - they come from the user's own repo but
 *         flow through our renderer; we treat them conservatively.
 *
 *         Backticks are replaced (not backslash-escaped) because GFM code
 *         spans delimited by a single ` cannot contain literal backticks.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\r?\n/g, ' ');
}
