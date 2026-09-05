/**
 * @brief: Thin axios wrapper for the three GitNexus Hub endpoints the
 *         Action talks to: list-repos (to resolve repoId from full name),
 *         refresh-blast (to recompute on-demand), and get-blast (to read
 *         the persisted result). All three use Bearer auth + a
 *         X-Device-Fingerprint header that the Hub requires for `gnx_`
 *         device tokens. The token value is passed via headers only and
 *         is never echoed, logged, or embedded in error messages here.
 */

import axios, { type AxiosResponse } from 'axios';
import {
  isBlastResult,
  normalizeBlastResult,
  type BlastResult,
} from './types/blast-result';
import { SchemaMismatchError } from './classify-error';

/**
 * @brief: Fingerprint sent in `X-Device-Fingerprint` for every Hub call.
 *         The Hub treats this string as opaque — its only purpose is to
 *         identify the calling "device" alongside the device token.
 */
export const ACTION_DEVICE_FINGERPRINT = 'gitnexus-check-action';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB hard cap on JSON body

/** SHA shape guard — 7..40 hex. A present-but-malformed headSha throws (loud). */
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[0-9a-f]{64}(?:-(?:[2-9]|[1-9][0-9]+))?$/;
const MAX_QUESTION_CHARS = 4_000;
const MAX_REPLY_WIRE_CHARS = 8_001;
const MAX_EVIDENCE = 9;
const MAX_EVIDENCE_PATH_CHARS = 500;

export type FindingReplyVerdict = 'supported' | 'uncertain' | 'not-supported';

export interface FindingReplyEvidence {
  path: string;
  startLine: number;
  kind: 'anchor' | 'caller' | 'graph';
}

export interface FindingReplyResult {
  schemaVersion: '1';
  fingerprint: string;
  analyzedSha: string;
  verdict: FindingReplyVerdict;
  reply: string;
  evidence: FindingReplyEvidence[];
}

/**
 * @brief: Validate a URL string at the trust boundary. Rejects anything
 *         not `https://` and strips at most one trailing slash so the
 *         path-joining in callers can assume `${hubUrl}/api/...` shape.
 *
 * @params: (raw: string) -> Caller-supplied URL (already trim-slashed by main.ts).
 *
 * @returns: string — a normalised https URL without trailing slash.
 * @throws: Error('hub-url must be https://...')
 */
export function validateHubUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error('hub-url must be https:// — http:// is not supported');
  }
  return trimmed;
}

/**
 * @brief: Resolve a GitHub `owner/repo` full name to the Hub's UUID for
 *         that repository. The Hub returns a bare array of repo objects
 *         (not `{repos:[...]}`); we match by `fullName` (camelCase).
 *
 * @params: (opts.hubUrl: string)   -> Hub base URL without trailing slash.
 * @params: (opts.token: string)    -> gnx_ device Bearer token.
 * @params: (opts.fullName: string) -> Repository full name, e.g. "acme/widget".
 *
 * @returns: string — Hub repo id (UUID).
 * @throws: Error('repo <name> not registered on Hub') when no match found.
 * @throws: SchemaMismatchError when response is not an array of {id,fullName}.
 * @call-routes: GET /api/repos
 */
export async function resolveRepoId(opts: {
  hubUrl: string;
  token: string;
  fullName: string;
}): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.fullName)) {
    throw new Error(`invalid repo full name: ${opts.fullName}`);
  }
  const res = await axios.get(`${opts.hubUrl}/api/repos`, {
    headers: hubHeaders(opts.token),
    timeout: DEFAULT_TIMEOUT_MS,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
  });
  const repos = parseRepoList(res);
  const match = repos.find((r) => r.fullName === opts.fullName);
  if (!match) {
    throw new Error(`repo ${opts.fullName} not registered on Hub`);
  }
  return match.id;
}

/**
 * @brief: Trigger a blast-radius recomputation for a single PR. The Hub
 *         endpoint is synchronous as of 2026-05-17 (returns 200 with a
 *         summary body), so no polling is needed. We discard the summary
 *         body — callers fetch the full result via `getBlast` immediately
 *         after this resolves.
 *
 * @params: (opts.hubUrl: string)   -> Hub base URL without trailing slash.
 * @params: (opts.token: string)    -> gnx_ device Bearer token.
 * @params: (opts.repoId: string)   -> Hub repo UUID from resolveRepoId.
 * @params: (opts.prNumber: number) -> GitHub PR number to refresh.
 * @params: (opts.headSha?: string) -> Optional PR head sha (review anchor); a
 *   present-but-malformed value throws, absent omits the ?headSha= query string.
 *
 * @returns: void
 * @call-routes: POST /api/repos/:repoId/prs/:prNumber/refresh (optional ?headSha=<sha>)
 */
export async function refreshBlast(opts: {
  hubUrl: string;
  token: string;
  repoId: string;
  prNumber: number;
  headSha?: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9-]+$/.test(opts.repoId)) {
    throw new Error(`invalid repoId shape: ${opts.repoId}`);
  }
  if (!Number.isInteger(opts.prNumber) || opts.prNumber <= 0) {
    throw new Error(`invalid prNumber: ${String(opts.prNumber)}`);
  }
  if (opts.headSha !== undefined && !SHA_RE.test(opts.headSha)) {
    throw new Error('invalid headSha shape');
  }
  await axios.post(
    `${opts.hubUrl}/api/repos/${opts.repoId}/prs/${opts.prNumber}/refresh`,
    {},
    {
      headers: hubHeaders(opts.token),
      params: opts.headSha ? { headSha: opts.headSha } : undefined,
      timeout: 5 * 60_000, // /refresh may run a full graph walk; allow 5min
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
    },
  );
}

/**
 * @brief: Fetch the persisted BlastResult for a PR. The Hub remaps
 *         snake_case columns to camelCase at its boundary, so the body we
 *         receive matches the BlastResult interface 1:1. We still run the
 *         body through `isBlastResult` + `normalizeBlastResult` so the
 *         renderer can iterate uniformly and the Action fails loud on
 *         schema regressions.
 *
 * @params: (opts.hubUrl: string)   -> Hub base URL without trailing slash.
 * @params: (opts.token: string)    -> gnx_ device Bearer token.
 * @params: (opts.repoId: string)   -> Hub repo UUID.
 * @params: (opts.prNumber: number) -> GitHub PR number.
 * @params: (opts.headSha?: string) -> Optional PR head sha (review anchor); a
 *   present-but-malformed value throws, absent omits the ?headSha= query string.
 *
 * @returns: BlastResult — normalised; all arrays guaranteed present.
 * @throws: SchemaMismatchError when the body fails isBlastResult validation.
 * @call-routes: GET /api/repos/:repoId/prs/:prNumber (optional ?headSha=<sha>)
 */
export async function getBlast(opts: {
  hubUrl: string;
  token: string;
  repoId: string;
  prNumber: number;
  headSha?: string;
}): Promise<BlastResult> {
  if (!/^[A-Za-z0-9-]+$/.test(opts.repoId)) {
    throw new Error(`invalid repoId shape: ${opts.repoId}`);
  }
  if (!Number.isInteger(opts.prNumber) || opts.prNumber <= 0) {
    throw new Error(`invalid prNumber: ${String(opts.prNumber)}`);
  }
  if (opts.headSha !== undefined && !SHA_RE.test(opts.headSha)) {
    throw new Error('invalid headSha shape');
  }
  const res = await axios.get(
    `${opts.hubUrl}/api/repos/${opts.repoId}/prs/${opts.prNumber}`,
    {
      headers: hubHeaders(opts.token),
      params: opts.headSha ? { headSha: opts.headSha } : undefined,
      timeout: DEFAULT_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
    },
  );
  const body: unknown = res.data;
  if (!isBlastResult(body)) {
    throw new SchemaMismatchError('GET /prs/:n response failed isBlastResult');
  }
  return normalizeBlastResult(body);
}

/** Ask the Hub to answer one human reply about one current inline finding. */
export async function requestFindingReply(opts: {
  hubUrl: string;
  token: string;
  repoId: string;
  prNumber: number;
  fingerprint: string;
  headSha: string;
  question: string;
  triggerCommentId: number;
}): Promise<FindingReplyResult> {
  if (!UUID_RE.test(opts.repoId)) throw new Error('invalid repoId shape');
  if (!Number.isSafeInteger(opts.prNumber) || opts.prNumber <= 0) {
    throw new Error('invalid prNumber');
  }
  if (!FINGERPRINT_RE.test(opts.fingerprint)) throw new Error('invalid fingerprint');
  if (!SHA_RE.test(opts.headSha)) throw new Error('invalid headSha shape');
  if (!Number.isSafeInteger(opts.triggerCommentId) || opts.triggerCommentId <= 0) {
    throw new Error('invalid trigger comment id');
  }
  const question = typeof opts.question === 'string' ? opts.question.trim() : '';
  if (!question || question.length > MAX_QUESTION_CHARS) throw new Error('invalid question');

  const hubUrl = validateHubUrl(opts.hubUrl);
  const res = await axios.post(
    `${hubUrl}/api/repos/${opts.repoId}/prs/${opts.prNumber}/findings/${opts.fingerprint}/reply`,
    { schemaVersion: '1', headSha: opts.headSha, question },
    {
      headers: {
        ...hubHeaders(opts.token),
        'Idempotency-Key': `gitnexus-review-reply:v1:${opts.triggerCommentId}`,
      },
      timeout: DEFAULT_TIMEOUT_MS,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
    },
  );
  if (
    !isFindingReplyResultFor(res.data, {
      fingerprint: opts.fingerprint,
      analyzedSha: opts.headSha,
    })
  ) {
    throw new SchemaMismatchError('POST finding reply response failed validation');
  }
  return res.data;
}

/** Strict response validation, also reused by the GitHub orchestrator. */
export function isFindingReplyResultFor(
  value: unknown,
  expected: { fingerprint: string; analyzedSha: string },
): value is FindingReplyResult {
  if (!isObject(value)) return false;
  if (!hasExactKeys(value, ['analyzedSha', 'evidence', 'fingerprint', 'reply', 'schemaVersion', 'verdict'])) {
    return false;
  }
  if (
    value.schemaVersion !== '1' ||
    value.fingerprint !== expected.fingerprint ||
    !FINGERPRINT_RE.test(String(value.fingerprint)) ||
    value.analyzedSha !== expected.analyzedSha ||
    !SHA_RE.test(String(value.analyzedSha)) ||
    (value.verdict !== 'supported' &&
      value.verdict !== 'uncertain' &&
      value.verdict !== 'not-supported') ||
    typeof value.reply !== 'string' ||
    value.reply.trim().length === 0 ||
    value.reply.length > MAX_REPLY_WIRE_CHARS ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAX_EVIDENCE
  ) {
    return false;
  }

  let anchors = 0;
  let otherEvidence = 0;
  for (const raw of value.evidence) {
    if (!isObject(raw) || !hasExactKeys(raw, ['kind', 'path', 'startLine'])) return false;
    if (
      typeof raw.path !== 'string' ||
      raw.path.trim().length === 0 ||
      raw.path.length > MAX_EVIDENCE_PATH_CHARS ||
      !Number.isSafeInteger(raw.startLine) ||
      Number(raw.startLine) <= 0 ||
      (raw.kind !== 'anchor' && raw.kind !== 'caller' && raw.kind !== 'graph')
    ) {
      return false;
    }
    if (raw.kind === 'anchor') anchors++;
    else otherEvidence++;
  }
  return anchors <= 1 && otherEvidence <= 8;
}

/**
 * @brief: Build the header set every Hub call uses. Centralised so the
 *         `X-Device-Fingerprint` requirement (added 2026-05 to the Hub for
 *         gnx_ device tokens) cannot be forgotten in one call site.
 *
 * @params: (token: string) -> gnx_ device Bearer token.
 *
 * @returns: Record<string, string> — headers ready to spread into axios opts.
 */
function hubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-Device-Fingerprint': ACTION_DEVICE_FINGERPRINT,
  };
}

/**
 * @brief: Parse the GET /api/repos response into a typed list. Tolerates
 *         both shapes the Hub has emitted over time: the modern bare
 *         array, and the older `{ repos: [...] }` envelope.
 */
function parseRepoList(res: AxiosResponse<unknown>): Array<{ id: string; fullName: string }> {
  const data: unknown = res.data;
  const raw = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray((data as { repos?: unknown }).repos)
      ? (data as { repos: unknown[] }).repos
      : null;
  if (!raw) {
    throw new SchemaMismatchError('GET /api/repos: expected array or { repos: [] }');
  }
  const repos: Array<{ id: string; fullName: string }> = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const id = entry.id;
    const fullName = entry.fullName ?? entry.full_name;
    if (typeof id === 'string' && typeof fullName === 'string') {
      repos.push({ id, fullName });
    }
  }
  return repos;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
