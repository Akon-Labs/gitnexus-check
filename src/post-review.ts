/**
 * @brief: Wave-2 inline-findings reconciler. Posts line-anchored PR *review*
 *         comments for anchored findings and keeps them in sync across re-runs,
 *         REST-only (no GraphQL). Reconcile v1:
 *           1. Delete any bot-owned PENDING review left by a crashed prior run.
 *           2. Scan existing BOT-authored review comments for our finding markers.
 *           3. PATCH comments whose rendered body changed; leave unchanged ones.
 *           4. Batch the genuinely new findings into ONE review
 *              (event 'COMMENT', commit_id = analyzedSha — MANDATORY, never
 *              default-latest, which a concurrent push would mis-anchor).
 *           5. Failure ladder: a batch 422 (one bad anchor rejects the whole
 *              review) retries each comment as its own single-comment review;
 *              survivors that still fail are returned for the MAIN comment's
 *              fallback section.
 *         Never throws — the caller's findings block is best-effort and must
 *         never fail the run or affect the gate. Token handling: the GITHUB_TOKEN
 *         flows through `@actions/github` and is never read, logged, or formatted
 *         here.
 *
 *         The identity filter (only OUR OWN comments/reviews are adoptable) reuses
 *         `isOwnedComment` from post-comment.ts verbatim — exact-login when the
 *         authenticated actor is known (a PAT), else the `[bot]`-suffix heuristic
 *         — so a human cannot plant a finding marker to hijack or suppress a
 *         review comment, and a user-PAT run reconciles its own comments.
 */

import * as github from '@actions/github';
import type { FindingItem } from './types/blast-result';
import { isOwnedComment, resolveActorLogin, type AuthenticatedActorClient } from './post-comment';
import { renderFindingComment, findingFingerprintFromBody } from './render-findings';

/**
 * @brief: The subset of a PR review comment we read while scanning for our
 *         markers. `path` + `line` (falling back to `original_line`) locate the
 *         comment's anchor so a re-run can detect when a finding moved lines — a
 *         review comment's anchor cannot be moved by a PATCH, so a moved finding
 *         must be re-created rather than patched in place.
 */
type ReviewCommentRecord = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
};

/** The subset of a PR review we read while cleaning up leftover PENDING reviews. */
type PullReviewRecord = {
  id: number;
  state?: string;
  user?: { login?: string; type?: string } | null;
};

/** One line-anchored comment in a batched review (NEW side, single line). */
export interface ReviewCommentInput {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

/**
 * @brief: The GitHub REST surface the reconciler depends on, narrowed to the
 *         five pulls endpoints we call so tests can pass a hand-rolled mock
 *         without satisfying the full Octokit interface (mirrors
 *         IssueCommentsClient in post-comment.ts).
 */
export interface ReviewClient {
  paginate: {
    iterator: (
      route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      params: { owner: string; repo: string; pull_number: number; per_page: number },
    ) => AsyncIterable<{ data: ReviewCommentRecord[] }>;
  };
  rest: {
    pulls: {
      listReviews: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
      }) => Promise<{ data: PullReviewRecord[] }>;
      createReview: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        event: 'COMMENT';
        body?: string;
        comments?: ReviewCommentInput[];
      }) => Promise<{ data: { id: number } }>;
      updateReviewComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<{ data: { id: number } }>;
      deletePendingReview: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        review_id: number;
      }) => Promise<{ data: unknown }>;
    };
    users: AuthenticatedActorClient['rest']['users'];
  };
}

/** Outcome of a reconcile run for the caller's outputs + fallback rendering. */
export interface ReconcileResult {
  posted: number;
  updated: number;
  failed: FindingItem[];
}

/** Internal ctx after the analyzedSha null-guard, so helpers see a non-null sha. */
interface ReconcileCtx {
  client: ReviewClient;
  owner: string;
  repo: string;
  prNumber: number;
  analyzedSha: string;
  // Resolved authenticated actor (a PAT github-token) or null (GITHUB_TOKEN).
  // Threaded into the marker scan + pending-review cleanup so we adopt/delete
  // ONLY our own artifacts (exact-login when known, bot heuristic otherwise).
  actorLogin: string | null;
}

/** Cap on pages we scan before giving up (mirrors post-comment.ts). */
const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * @brief: Reconcile the anchored findings into PR review comments. Returns the
 *         count posted, the count updated in place, and the findings whose
 *         inline post could not happen (for the fallback section). Never throws.
 *
 * @params: (opts.client)       -> Narrowed review client (asReviewClient).
 * @params: (opts.owner/repo)   -> Repo coordinates.
 * @params: (opts.prNumber)     -> PR number (pull_number to GitHub).
 * @params: (opts.analyzedSha)  -> The commit the anchors are valid at; the review
 *                                 commit_id. Null → nothing is posted (all → fallback).
 * @params: (opts.items)        -> Candidate findings; only anchored ones are posted.
 *
 * @returns: ReconcileResult — { posted, updated, failed[] }.
 */
export async function reconcileFindings(opts: {
  client: ReviewClient;
  owner: string;
  repo: string;
  prNumber: number;
  analyzedSha: string | null;
  items: FindingItem[];
}): Promise<ReconcileResult> {
  const result: ReconcileResult = { posted: 0, updated: 0, failed: [] };

  // Only anchored items with a valid NEW-side line are postable inline; anything
  // else is the caller's fallback-section responsibility and never reaches here.
  const postable = opts.items.filter((it) => it.anchored && it.anchor);
  if (postable.length === 0) return result;

  // commit_id is MANDATORY — never default-latest (a concurrent push would
  // mis-anchor every comment). With no analyzedSha we cannot post safely, so
  // every finding degrades to the fallback section.
  if (!opts.analyzedSha) {
    result.failed.push(...postable);
    return result;
  }

  // Resolve the authenticated actor once (never throws → null on GITHUB_TOKEN).
  // A user-PAT github-token resolves to its owner login so we recognise our OWN
  // prior finding comments (idempotency) and never delete another bot's pending
  // review; GITHUB_TOKEN → null falls back to the [bot]-suffix heuristic.
  const actorLogin = await resolveActorLogin(opts.client);
  const ctx: ReconcileCtx = {
    client: opts.client,
    owner: opts.owner,
    repo: opts.repo,
    prNumber: opts.prNumber,
    analyzedSha: opts.analyzedSha,
    actorLogin,
  };

  try {
    // 1. Clear any leftover bot-owned PENDING review (best-effort).
    await deletePendingBotReviews(ctx);

    // 2. Map our existing finding comments by fingerprint (throws only on a real
    //    list failure — an empty PR legitimately yields an empty map).
    const existing = await scanExistingFindingComments(ctx);

    // 3. PATCH changed bodies; collect genuinely new findings.
    const toCreate: FindingItem[] = [];
    for (const item of postable) {
      const body = renderFindingComment(item);
      const match = existing.get(item.fingerprint);
      if (!match) {
        toCreate.push(item);
        continue;
      }
      // A review comment's ANCHOR cannot move via PATCH: patching only rewrites
      // the body, leaving a moved finding stuck on its old line. When the finding
      // now anchors to a different path/line than the existing comment, re-create
      // it at the correct line instead of patching. The old comment is left as-is
      // (a stale comment on an outdated line is acceptable) and is NOT counted as
      // updated — only the fresh create counts, so there is no double-report.
      if (anchorMoved(item, match)) {
        toCreate.push(item);
        continue;
      }
      if (match.body === body) continue; // unchanged → no-op
      try {
        await ctx.client.rest.pulls.updateReviewComment({
          owner: ctx.owner,
          repo: ctx.repo,
          comment_id: match.id,
          body,
        });
        result.updated += 1;
      } catch {
        // A failed PATCH leaves the (stale) comment visible inline; do NOT also
        // demote it to the fallback section (that would double-report it).
      }
    }

    // 4 + 5. Batch-create the new findings; ladder down to per-comment on 422.
    if (toCreate.length > 0) {
      await createReviewBatch(ctx, toCreate, result);
    }
  } catch {
    // A real failure before any post (e.g. listing threw) must never throw out
    // of the reconciler. Degrade every not-yet-posted finding to the fallback
    // section — guarded so we never double-report something already posted.
    if (result.posted === 0 && result.updated === 0) {
      result.failed = [...result.failed, ...postable];
    }
  }

  return result;
}

/**
 * @brief: Delete any bot-owned PENDING review (one PENDING per user/PR) left by a
 *         crashed prior run, so createReview does not 422 on "already has a
 *         pending review". Best-effort: a failure here is swallowed and the
 *         create ladder handles any resulting 422.
 */
async function deletePendingBotReviews(ctx: ReconcileCtx): Promise<void> {
  try {
    const res = await ctx.client.rest.pulls.listReviews({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      per_page: PER_PAGE,
    });
    for (const review of res.data) {
      if (review.state !== 'PENDING' || !isOwnedComment(review.user, ctx.actorLogin)) continue;
      try {
        await ctx.client.rest.pulls.deletePendingReview({
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.prNumber,
          review_id: review.id,
        });
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // listing reviews failed — skip cleanup and continue.
  }
}

/** An existing finding comment: its id + rendered body and its current anchor. */
interface ExistingFindingComment {
  id: number;
  body: string;
  // The comment's anchor, when the list API reported it: `line` falls back to
  // `original_line`. Absent when unknown, in which case a re-run keeps the
  // existing PATCH-in-place behavior rather than assuming the anchor moved.
  path?: string;
  line?: number;
}

/**
 * @brief: Page the PR's review comments and map fingerprint → the existing
 *         comment (id, body, anchor) for every OWNED comment carrying a finding
 *         marker. The identity filter (isOwnedComment) means a human-planted
 *         marker — or another bot's comment when we know our actor — is ignored,
 *         so a commenter cannot hijack or suppress a finding thread. May throw on
 *         a genuine list failure (caught by the caller, which then degrades to the
 *         fallback section); an empty PR simply yields an empty map.
 */
async function scanExistingFindingComments(
  ctx: ReconcileCtx,
): Promise<Map<string, ExistingFindingComment>> {
  const map = new Map<string, ExistingFindingComment>();
  const iterator = ctx.client.paginate.iterator(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
    {
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      per_page: PER_PAGE,
    },
  );
  let pages = 0;
  for await (const page of iterator) {
    pages += 1;
    for (const comment of page.data) {
      if (typeof comment.body !== 'string') continue;
      if (!isOwnedComment(comment.user, ctx.actorLogin)) continue;
      const fp = findingFingerprintFromBody(comment.body);
      if (fp) {
        const entry: ExistingFindingComment = { id: comment.id, body: comment.body };
        if (typeof comment.path === 'string') entry.path = comment.path;
        // A review comment API row carries `line` (NEW side) and falls back to
        // `original_line`; keep only a positive number.
        const line = comment.line ?? comment.original_line;
        if (typeof line === 'number' && line > 0) entry.line = line;
        map.set(fp, entry);
      }
    }
    if (pages >= MAX_PAGES) break;
  }
  return map;
}

/**
 * @brief: Post the new findings as ONE batched review. The per-comment retry
 *         ladder is entered ONLY on a CONFIRMED 422: createReview is all-or-
 *         nothing on validation, so a 422 means NOTHING posted and retrying each
 *         comment individually is safe (good anchors survive, the rest go to
 *         result.failed for the fallback section). For any OTHER failure
 *         (403 / 5xx / network) the batch may have PARTIALLY applied, so a
 *         per-comment retry would duplicate — return every finding as failed
 *         instead. Never throws.
 */
async function createReviewBatch(
  ctx: ReconcileCtx,
  toCreate: FindingItem[],
  result: ReconcileResult,
): Promise<void> {
  try {
    await ctx.client.rest.pulls.createReview({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.prNumber,
      commit_id: ctx.analyzedSha,
      event: 'COMMENT',
      comments: toCreate.map(toReviewComment),
    });
    result.posted += toCreate.length;
    return;
  } catch (err) {
    // Only a validation 422 (all-or-nothing → nothing posted) is safe to retry
    // per-comment. A non-422 error may have partially applied the batch, so
    // degrade every finding to the fallback section rather than risk duplicates.
    if (!isValidationError(err)) {
      result.failed.push(...toCreate);
      return;
    }
  }
  for (const item of toCreate) {
    try {
      await ctx.client.rest.pulls.createReview({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
        commit_id: ctx.analyzedSha,
        event: 'COMMENT',
        comments: [toReviewComment(item)],
      });
      result.posted += 1;
    } catch {
      result.failed.push(item);
    }
  }
}

/**
 * @brief: True when a finding's current anchor (path + NEW-side start line)
 *         differs from the existing comment's anchor, so a PATCH would leave it
 *         stranded on the old line and it must be re-created. Returns false when
 *         the existing comment's anchor is unknown (the list API omitted it) —
 *         we cannot prove a move, so we keep the PATCH-in-place behavior.
 */
function anchorMoved(item: FindingItem, existing: { path?: string; line?: number }): boolean {
  if (typeof existing.path !== 'string' || typeof existing.line !== 'number') return false;
  const line = (item.anchor as { startLine: number }).startLine;
  return existing.path !== item.path || existing.line !== line;
}

/**
 * @brief: True when a thrown value is an HTTP 422 (validation). Recognises both
 *         the Octokit RequestError shape (`err.status`) and the axios shape
 *         (`err.response.status`). Used to gate the per-comment retry ladder to
 *         the ONE batch failure mode where nothing was posted.
 */
function isValidationError(err: unknown): boolean {
  const e = err as { status?: unknown; response?: { status?: unknown } };
  return e?.status === 422 || e?.response?.status === 422;
}

/** Map a finding to a single-line NEW-side review comment. Anchor is guaranteed present. */
function toReviewComment(item: FindingItem): ReviewCommentInput {
  return {
    path: item.path,
    line: (item.anchor as { startLine: number }).startLine,
    side: 'RIGHT',
    body: renderFindingComment(item),
  };
}

/**
 * @brief: Adapt a full Octokit instance into the narrowed ReviewClient shape, so
 *         main.ts is the only file touching the broader Octokit surface and the
 *         reconciler stays test-friendly with a hand-rolled mock (mirrors
 *         asIssueCommentsClient in post-comment.ts).
 *
 * @params: (octokit) -> Auth'd Octokit from github.getOctokit.
 * @returns: ReviewClient — narrowed client for the reconciler to use.
 */
export function asReviewClient(octokit: ReturnType<typeof github.getOctokit>): ReviewClient {
  return {
    paginate: {
      iterator: (route, params) => octokit.paginate.iterator(route, params),
    },
    rest: {
      pulls: {
        listReviews: (params) => octokit.rest.pulls.listReviews(params),
        createReview: (params) => octokit.rest.pulls.createReview(params),
        updateReviewComment: (params) => octokit.rest.pulls.updateReviewComment(params),
        deletePendingReview: (params) => octokit.rest.pulls.deletePendingReview(params),
      },
      users: {
        getAuthenticated: () => octokit.rest.users.getAuthenticated(),
      },
    },
  };
}
