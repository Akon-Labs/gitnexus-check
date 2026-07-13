/**
 * @brief: Typed view of the `pr_blast_results` shape returned by the Hub's
 *         GET /api/repos/:repoId/prs/:prNumber endpoint. Field names are
 *         camelCase — the Hub already remaps from snake_case columns at
 *         its boundary, so this Action consumes them unchanged.
 *
 * @params: (blastLevel)      -> Overall risk level for the PR.
 * @params: (changedSymbols)  -> Symbols whose definition changed in the diff.
 * @params: (d1Symbols)       -> Direct dependents (depth-1 in the call graph).
 * @params: (d2Symbols)       -> Indirect dependents (depth-2).
 * @params: (d3Symbols)       -> Transitive dependents (depth-3).
 * @params: (affectedFlows)   -> Execution flows touched by the change.
 * @params: (affectedModules) -> Cluster-level summary; drives the "Architecture Impact" section.
 * @params: (changedFiles)    -> Per-file change-status (added/modified/removed/renamed).
 * @params: (fileRiskLevel)   -> File-class risk (security, build, etc.) — independent of blastLevel.
 * @params: (riskFiles)       -> Per-file risk entries.
 * @params: (graphData)       -> Force-directed graph payload used by the Hub UI; opaque to the Action.
 * @params: (truncated)       -> Hub-side truncation marker.
 * @params: (stale)           -> Computed against an older indexed commit than the current HEAD.
 * @params: (prTitle/prAuthor/prBranch/prStatus) -> PR-level metadata; either party may set null.
 * @params: (computedAt)      -> ISO timestamp when the Hub last computed the result.
 * @params: (crossRepo)       -> Cross-repo blast envelope; optional for back-compat with older Hub builds. Accepted + preserved here, rendered later.
 */

export type BlastLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * @brief: Hub's lightly-typed view of a code symbol. Used both for changed
 *         symbols and for blast-radius entries. Some symbols are file-level
 *         (no startLine/endLine); those line fields are null in that case.
 */
export interface SymbolRef {
  id: string;
  name: string;
  type: string; // e.g. 'Function' | 'Method' | 'Class' | 'Route' | 'File' | …
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

/**
 * @brief: Module cluster touched by the PR. `hits` is the Hub-side count of
 *         symbol mutations attributed to the cluster; `direct` flags whether
 *         a changed symbol lives in the cluster or only a dependent does.
 */
export interface AffectedModule {
  name: string;
  hits: number;
  direct: boolean;
}

/**
 * @brief: Per-file change record from the Hub diff parser. Status values
 *         mirror GitHub's PR-files API surface (`added` | `modified` |
 *         `removed` | `renamed` | `copied` | `changed` | `unchanged`).
 */
export interface ChangedFile {
  path: string;
  status: string;
}

/**
 * @brief: File-class risk entry. `category` is a free-form bucket name
 *         (Documentation, Source, Test, Build, etc.); we render it as-is.
 */
export interface RiskFile {
  path: string;
  risk: BlastLevel;
  status: string;
  category?: string;
}

/**
 * @brief: Execution flow touched by the PR, as reported by the Hub. All
 *         fields are optional because the Hub populates them opportunistically
 *         depending on what the flow analyser resolved; the renderer narrows
 *         each field with a `typeof` guard before use rather than trusting
 *         presence.
 *
 * @params: (name)        -> Legacy display name (older Hub builds).
 * @params: (processId)   -> Stable id of the execution flow / process.
 * @params: (processName) -> Human-readable flow name; preferred for display.
 * @params: (hitSymbols)  -> Symbol names within the flow that the change touched.
 * @params: (hitCount)    -> Number of touched symbols; drives row ordering.
 */
export interface AffectedFlow {
  name?: string;
  processId?: string;
  processName?: string;
  hitSymbols?: string[];
  hitCount?: number;
}

/**
 * @brief: Graph-data payload (nodes + edges) used by the Hub UI to draw the
 *         force-directed view. The Action never inspects fields beyond
 *         shape — keeping it opaque future-proofs against Hub UI changes.
 */
export interface BlastGraphData {
  nodes: ReadonlyArray<{ [k: string]: unknown }>;
  links: ReadonlyArray<{ [k: string]: unknown }>;
}

/**
 * @brief: A consumer in another repo references a symbol changed in this PR.
 *         `kind` is the renderer's switch discriminant; the remaining fields
 *         are tolerated-optional in spirit (the Hub may add more), but the
 *         renderer only reads what it needs and guards each access.
 *
 *         The HTTP symbol tier (W1.2b) adds three additive-optional fields —
 *         they carry no schema bump (the envelope stays schemaVersion '1') and
 *         are simply absent on older Hubs, so every read below is guarded:
 *         `consumerSymbol.startLine` (call-site line for the imported-symbol
 *         channel), `providerContract` (the coupled HTTP route — kind 'http'
 *         plus method/path — which routes a sym→sym edge into the "HTTP routes"
 *         channel), `callSites` (the consumer's depth-1 call sites, capped ~5
 *         by the Hub), and `consumerD1Count` (full direct-caller count, ≥ the
 *         rendered callSites length).
 */
export interface SymbolCrossRepoFinding {
  kind: 'symbol';
  consumerRepo: string;
  consumerSymbol: { name: string; filePath: string; startLine?: number | null } | null;
  providerSymbol: { name: string; filePath: string; symbolLabel: string } | null;
  via: string;
  edgeType: string;
  detectionTier: string;
  confidence: number;
  providerContract?: { kind: string; method?: string; path?: string };
  callSites?: { filePath: string; startLine: number }[];
  consumerD1Count?: number;
}

/** A whole repo consumes a changed contract artifact (HTTP route, proto, topic, …). */
export interface ContractCrossRepoFinding {
  kind: 'contract';
  consumerRepo: string;
  via: string;
  changedFile?: string; // present only on Hubs that resolve the defining file
  edgeType: string;
  detectionTier: string;
  confidence: number;
}

/** The changed symbol is a step in a cross-repo execution flow. */
export interface FlowCrossRepoFinding {
  kind: 'flow';
  consumerRepo: string; // '' — a flow spans repos; see flow.repoIds
  via: string;
  flow: { label: string; step: number; stepCount: number; repoIds: string[] };
  edgeType: string;
  detectionTier: string;
  confidence: number;
}

/**
 * @brief: Discriminated union of every cross-repo finding kind. The renderer
 *         switches on `kind` with a default no-op, so an unknown future kind
 *         (e.g. the reserved 'breakage') renders as nothing rather than throwing.
 */
export type CrossRepoFinding =
  | SymbolCrossRepoFinding
  | ContractCrossRepoFinding
  | FlowCrossRepoFinding;

/** Per-group metadata. `name` is wire-only — the renderer NEVER prints it (§5.2). */
export interface CrossRepoGroup {
  id: string;
  name: string;
  lastAnalyzedAt: string | null;
  stale: boolean;
}

/**
 * @brief: A symbol changed in THIS PR that is brand-new here (an added export),
 *         so no cross-repo edge to it can exist yet — its downstream impact is
 *         "not yet knowable" until a consumer re-analyzes against the new
 *         surface. The Hub owns the element shape; the renderer reports only the
 *         count, so both fields are optional and the array is carried through
 *         `normalizeCrossRepo` verbatim.
 */
export interface NotYetKnowableSymbol {
  name?: string;
  filePath?: string;
}

/**
 * @brief: Cross-repo blast-radius envelope returned by the Hub alongside the
 *         single-repo result. The Hub emits a populated envelope when the
 *         repo belongs to a ready group, or a zero-state envelope otherwise;
 *         either way the field is always present on new Hub builds.
 *
 *         `findings`/`groups` are typed unions for the renderer to switch on;
 *         `normalizeCrossRepo` validates only that they are arrays (shallow,
 *         trust-boundary) and casts — the renderer tolerates unknown members.
 *
 * @params: (schemaVersion) -> Hub envelope schema tag. A value other than '1'
 *                             degrades to an error envelope at normalize time
 *                             (we cannot safely render unknown semantics).
 * @params: (findings)      -> Cross-repo findings (symbol / contract / flow).
 * @params: (groups)        -> Per-group metadata (id, name, freshness).
 * @params: (truncated)     -> Hub-side cap marker on the findings list.
 * @params: (error)         -> Non-null when the join could-not-run; null when it
 *                             ran cleanly (distinct from an empty findings list).
 * @params: (notYetKnowable)-> Changed symbols that are brand-new in this PR, so
 *                             their cross-repo impact cannot be computed yet.
 *                             Additive-optional; omitted (not `[]`) when the Hub
 *                             sends nothing or a malformed value, so an absent
 *                             field reads as count 0.
 */
export interface CrossRepoResult {
  schemaVersion: string;
  findings: CrossRepoFinding[];
  groups: CrossRepoGroup[];
  truncated: boolean;
  error: string | null;
  notYetKnowable?: NotYetKnowableSymbol[];
}

/**
 * @brief: Zero-state cross-repo envelope. Byte-matches the Hub's own
 *         zero-state literal in routes/blast.ts so an Action that fills a
 *         missing `crossRepo` produces exactly what a fresh Hub would have
 *         sent for a repo with no ready groups.
 */
export const EMPTY_CROSS_REPO: CrossRepoResult = {
  schemaVersion: '1',
  findings: [],
  groups: [],
  truncated: false,
  error: null,
};

/**
 * @brief: "Since last commit" delta returned by the Hub when a PR receives a
 *         new push: a short Hub-generated `summary` of what changed since the
 *         previously-reviewed commit, anchored to the new `headSha`. Optional +
 *         nullable on the BlastResult — older Hubs omit it entirely, and the Hub
 *         sends null when there is no prior commit to diff against.
 *
 * @params: (headSha) -> The PR head commit sha this delta was computed against.
 * @params: (summary) -> Hub-generated prose describing the change since last commit.
 */
export interface SinceLastCommit {
  headSha: string;
  summary: string;
}

export interface BlastResult {
  blastLevel: BlastLevel;

  changedSymbols: SymbolRef[];
  d1Symbols: SymbolRef[];
  d2Symbols: SymbolRef[];
  d3Symbols: SymbolRef[];

  affectedFlows: AffectedFlow[];
  affectedModules: AffectedModule[];
  changedFiles: ChangedFile[];

  fileRiskLevel: BlastLevel | null;
  riskFiles: RiskFile[];

  graphData: BlastGraphData;

  truncated: boolean;
  stale: boolean;

  prTitle: string | null;
  prAuthor: string | null;
  prBranch: string | null;
  prStatus: string | null;

  computedAt: string; // ISO timestamp

  // keep optional — do not tighten. render-comment.test.ts passes un-cast
  // object literals straight into normalizeBlastResult(value: BlastResult);
  // a required field would break those ~10 literals at compile time.
  crossRepo?: CrossRepoResult;

  // LLM "## Summary" digest produced by the Hub (Hub holds the Azure key and
  // rate-limits the call). Absent/null on older Hubs or when the Hub skipped
  // it — the Action then posts the deterministic comment unchanged.
  aiSummary?: string | null;

  // "Since last commit" delta produced by the Hub when a PR is re-pushed.
  // Absent on older Hubs; null when there is no prior commit to diff against.
  // Rendered above the digest in the single upsert-by-marker comment.
  sinceLastCommit?: SinceLastCommit | null;
}

/**
 * @brief: Validate that an unknown value matches the BlastResult shape we
 *         expect from the Hub. Tolerates absent arrays (treats them as []
 *         so callers iterate uniformly) and accepts unknown enum values
 *         for `blastLevel` only when the shape is otherwise correct — the
 *         caller is expected to default unrecognised values to `'LOW'`
 *         at render time rather than throw here.
 *
 * @params: (value: unknown) -> The parsed JSON body returned by the Hub.
 *
 * @returns: boolean (TypeScript narrows to BlastResult on `true`).
 */
export function isBlastResult(value: unknown): value is BlastResult {
  if (!isObject(value)) return false;

  if (typeof value.blastLevel !== 'string') return false;
  if (typeof value.truncated !== 'boolean') return false;
  if (typeof value.computedAt !== 'string') return false;

  // stale + prStatus arrived later in the Hub schema; older deployments
  // may omit them. Accept either shape so the Action keeps working across
  // a window of Hub versions; renderer fills defaults.
  if (
    'stale' in value &&
    value.stale !== null &&
    value.stale !== undefined &&
    typeof value.stale !== 'boolean'
  ) {
    return false;
  }

  const arrayFields = [
    'changedSymbols',
    'd1Symbols',
    'd2Symbols',
    'd3Symbols',
    'affectedFlows',
    'affectedModules',
    'changedFiles',
    'riskFiles',
  ] as const;
  for (const field of arrayFields) {
    if (!(field in value)) continue;
    const v = value[field];
    if (v !== null && v !== undefined && !Array.isArray(v)) return false;
  }

  // fileRiskLevel may be null
  if (
    value.fileRiskLevel !== null &&
    value.fileRiskLevel !== undefined &&
    typeof value.fileRiskLevel !== 'string'
  ) {
    return false;
  }

  // graphData is optional in old Hub builds and always present in new ones.
  if ('graphData' in value && value.graphData !== null && value.graphData !== undefined) {
    if (!isObject(value.graphData)) return false;
  }

  // crossRepo arrived later in the Hub schema; older deployments omit it.
  // Shallow tolerance only — when present, require an object whose findings
  // and groups (if present) are arrays. The per-finding shape is the
  // renderer's concern, so we do NOT validate beyond that.
  if ('crossRepo' in value && value.crossRepo !== null && value.crossRepo !== undefined) {
    if (!isObject(value.crossRepo)) return false;
    const { findings, groups } = value.crossRepo;
    if (findings !== null && findings !== undefined && !Array.isArray(findings)) return false;
    if (groups !== null && groups !== undefined && !Array.isArray(groups)) return false;
  }

  // aiSummary arrived later too; older Hubs omit it. Accept absent/null;
  // reject only a present non-string value.
  if (
    'aiSummary' in value &&
    value.aiSummary !== null &&
    value.aiSummary !== undefined &&
    typeof value.aiSummary !== 'string'
  ) {
    return false;
  }

  // sinceLastCommit arrived later too; older Hubs omit it. Tolerant — when
  // present it must be null or an object. We do NOT deep-reject a partial
  // object here; normalizeSinceLastCommit is the sole type gate that turns a
  // malformed/partial value into null. Reject only a present non-object,
  // non-null value (e.g. a string or number).
  if (
    'sinceLastCommit' in value &&
    value.sinceLastCommit !== null &&
    value.sinceLastCommit !== undefined &&
    !isObject(value.sinceLastCommit)
  ) {
    return false;
  }

  return true;
}

/**
 * @brief: Sole type gate for the `sinceLastCommit` delta. Returns the well-formed
 *         SinceLastCommit ONLY when both `headSha` AND `summary` are non-empty
 *         strings; every other shape (absent, null, non-object, missing field,
 *         empty string, non-string field) collapses to null. The renderer
 *         tolerates null, so malformed/partial Hub values render as no delta
 *         rather than throwing.
 *
 * @params: (v: unknown) -> The `sinceLastCommit` field off a Hub response body.
 *
 * @returns: SinceLastCommit | null — the object when valid, otherwise null.
 */
export function normalizeSinceLastCommit(v: unknown): SinceLastCommit | null {
  if (!isObject(v)) return null;
  const { headSha, summary } = v;
  if (typeof headSha !== 'string' || headSha.length === 0) return null;
  if (typeof summary !== 'string' || summary.length === 0) return null;
  return { headSha, summary };
}

/**
 * @brief: Coerce a BlastResult-shaped object into a fully-populated
 *         BlastResult by filling missing arrays with `[]`, normalising
 *         optional nullable scalars, and clamping `blastLevel` to the
 *         four known values (unknown → 'LOW' as a conservative default).
 *
 *         Call this AFTER `isBlastResult` has returned true. It exists so
 *         the renderer never has to write `?? []` on every section.
 *
 * @params: (value: BlastResult) -> Hub response that has passed isBlastResult.
 *
 * @returns: BlastResult with all array fields present and blastLevel clamped.
 */
export function normalizeBlastResult(value: BlastResult): BlastResult {
  const level = clampBlastLevel(value.blastLevel);
  return {
    blastLevel: level,
    changedSymbols: value.changedSymbols ?? [],
    d1Symbols: value.d1Symbols ?? [],
    d2Symbols: value.d2Symbols ?? [],
    d3Symbols: value.d3Symbols ?? [],
    affectedFlows: value.affectedFlows ?? [],
    affectedModules: value.affectedModules ?? [],
    changedFiles: value.changedFiles ?? [],
    fileRiskLevel: clampOptionalBlastLevel(value.fileRiskLevel),
    riskFiles: value.riskFiles ?? [],
    graphData: value.graphData ?? { nodes: [], links: [] },
    crossRepo: normalizeCrossRepo(value.crossRepo),
    aiSummary: typeof value.aiSummary === 'string' ? value.aiSummary : null,
    sinceLastCommit: normalizeSinceLastCommit(value.sinceLastCommit),
    truncated: Boolean(value.truncated),
    stale: Boolean(value.stale),
    prTitle: value.prTitle ?? null,
    prAuthor: value.prAuthor ?? null,
    prBranch: value.prBranch ?? null,
    prStatus: value.prStatus ?? null,
    computedAt: value.computedAt,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * @brief: Coerce an unknown `crossRepo` value into a well-formed
 *         CrossRepoResult so the renderer can read it without `??` on every
 *         field. Returns EMPTY_CROSS_REPO when the value is absent or not an
 *         object; otherwise fills each field with a type-checked default.
 *         `findings`/`groups` are passed through verbatim when they are arrays.
 *
 *         Version-aware: a `schemaVersion` other than '1' degrades to an error
 *         envelope (empty findings + an `error`) rather than mis-rendering data
 *         whose semantics may have changed — the schemaVersion exists for this.
 *
 * @params: (v: unknown) -> The `crossRepo` field off a Hub response body.
 *
 * @returns: CrossRepoResult — always a complete envelope.
 */
function normalizeCrossRepo(v: unknown): CrossRepoResult {
  if (!isObject(v)) return EMPTY_CROSS_REPO;
  const sv = typeof v.schemaVersion === 'string' ? v.schemaVersion : undefined;
  if (sv !== undefined && sv !== '1') {
    return {
      schemaVersion: '1',
      findings: [],
      groups: [],
      truncated: false,
      error: `unsupported crossRepo schema version: ${sv}`,
    };
  }
  // Shallow trust-boundary validation: confirm arrays, then cast. The renderer
  // switches on `kind` with a default no-op, so malformed members render as
  // nothing rather than throwing — deep per-finding validation would reject
  // valid responses from a Hub that adds fields.
  const result: CrossRepoResult = {
    schemaVersion: '1',
    findings: Array.isArray(v.findings) ? (v.findings as CrossRepoFinding[]) : [],
    groups: Array.isArray(v.groups) ? (v.groups as CrossRepoGroup[]) : [],
    truncated: Boolean(v.truncated),
    error: typeof v.error === 'string' ? v.error : null,
  };
  // Carry `notYetKnowable` through verbatim when it is an array (the Hub emits it
  // for PRs that add brand-new exports). Tolerant: a non-array / malformed value
  // is omitted rather than coerced to `[]`, so the renderer's `?.length ?? 0`
  // reads it as count 0 and the caveat stays silent — matching the absent-field
  // case and preserving the byte-identical zero-state render.
  if (Array.isArray(v.notYetKnowable)) {
    result.notYetKnowable = v.notYetKnowable as NotYetKnowableSymbol[];
  }
  return result;
}

function clampBlastLevel(v: string): BlastLevel {
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? v : 'LOW';
}

function clampOptionalBlastLevel(v: string | null | undefined): BlastLevel | null {
  if (v === null || v === undefined) return null;
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? v : null;
}
