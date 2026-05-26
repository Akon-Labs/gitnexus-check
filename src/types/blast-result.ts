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
  if ('stale' in value && typeof value.stale !== 'boolean' && value.stale !== undefined) {
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

  return true;
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

function clampBlastLevel(v: string): BlastLevel {
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? v : 'LOW';
}

function clampOptionalBlastLevel(v: string | null | undefined): BlastLevel | null {
  if (v === null || v === undefined) return null;
  return v === 'LOW' || v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? v : null;
}
