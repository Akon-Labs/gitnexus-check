/**
 * @brief: gitnexus-check action entrypoint. Reads inputs, validates the
 *         event, resolves the Hub repoId, refreshes + reads the blast
 *         result, renders the PR comment, and posts (or updates) it. All
 *         library calls throw on failure; this module is the only place
 *         that touches `core.setFailed`. Token values never appear in any
 *         log line, output, or error message produced from here.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { classifyError } from './classify-error';
import {
  resolveRepoId,
  refreshBlast,
  getBlast,
  validateHubUrl,
} from './hub-client';
import { renderComment, COMMENT_MARKER } from './render-comment';
import { asIssueCommentsClient, postOrUpdateComment } from './post-comment';
import { parseThreshold, evaluateGate } from './gate';
import { composeWithDigest, renderSinceCommitComment, sinceCommitMarker } from './slm-format';

/**
 * @brief: Top-level orchestration. Sequence:
 *           1. Read inputs + validate event shape (non-PR → warn + exit 0).
 *           2. parseThreshold → validate fail-on-blast-level (bad → fail fast).
 *           3. resolveRepoId  → Hub UUID for owner/repo.
 *           4. refreshBlast   → POST /refresh (synchronous on the live Hub).
 *           5. getBlast       → GET /prs/:n; validated by isBlastResult.
 *           6. renderComment  → markdown ≤ CHAR_BUDGET.
 *           6b. aiSummary     → if the Hub returned a digest, splice it on top
 *                               and collapse detail; else post (6) unchanged.
 *           7. postOrUpdate   → Octokit upsert by marker (MAIN comment). Fork
 *                               PRs carry a read-only token: they skip the write
 *                               and log the rendered comment instead, and any
 *                               403 degrades to a warning. Neither fails the run.
 *           6c. sinceLastCommit → if present, post a SEPARATE per-SHA comment;
 *                               best-effort, never fails the run (skipped on forks).
 *           8. setOutput      → comment-id, blast-level, gate-decision.
 *           9. evaluateGate   → setFailed iff blast level meets/exceeds threshold.
 *
 *         Every Hub call wraps in try/catch → classifyError('hub'); every
 *         GitHub call wraps similarly with 'github' context. The gate is the
 *         only setFailed driven by a successful run and fires AFTER the
 *         comment is posted — so a fork PR (log-only) and a 403 (warning) still
 *         reach it. On any other thrown classified message we call
 *         core.error + core.setFailed and return — no further work after the
 *         first failure.
 *
 * @returns: void — exits via core.setFailed on error or returns cleanly.
 */
export async function main(): Promise<void> {
  const hubUrl = validateHubUrl(core.getInput('hub-url', { required: true }));
  const token = core.getInput('token', { required: true });
  const githubToken = core.getInput('github-token', { required: true });

  const ctx = github.context;
  if (ctx.eventName !== 'pull_request') {
    core.warning(`gitnexus-check runs on pull_request events; got "${ctx.eventName}". Skipping.`);
    return;
  }
  const pr = ctx.payload.pull_request;
  if (!pr || typeof pr.number !== 'number') {
    core.warning('pull_request payload missing — skipping.');
    return;
  }
  const prNumber: number = pr.number;
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const fullName = `${owner}/${repo}`;
  // New-commit review anchor: the PR head sha, if the payload carries a valid
  // one. Degrades to undefined (never throws) so a malformed/absent sha simply
  // omits the anchor rather than failing the run.
  const headSha = readHeadSha(ctx.payload);
  // Fork PRs run with a read-only GITHUB_TOKEN, so any comment write 403s. We
  // detect the fork from the webhook payload up-front and degrade to log-only
  // (see §7) rather than failing the run after the Hub has done its work.
  const isFork = isForkPr(ctx.payload);

  core.info(`GitNexus Review — PR #${prNumber} (${fullName})`);

  // ── 2. Validate the gate threshold up-front so a typo fails fast,
  //        before any Hub round-trip. Empty input → advisory (null).
  let threshold;
  try {
    threshold = parseThreshold(core.getInput('fail-on-blast-level'));
  } catch (err) {
    return fail(err, 'config', 'parseThreshold');
  }

  let repoId: string;
  try {
    repoId = await resolveRepoId({ hubUrl, token, fullName });
  } catch (err) {
    return fail(err, 'hub', 'resolveRepoId');
  }

  try {
    await refreshBlast({ hubUrl, token, repoId, prNumber, headSha });
  } catch (err) {
    return fail(err, 'hub', 'refreshBlast');
  }

  let blast;
  try {
    blast = await getBlast({ hubUrl, token, repoId, prNumber, headSha });
  } catch (err) {
    return fail(err, 'hub', 'getBlast');
  }

  const rawBody = renderComment(blast, { prNumber, hubUrl });

  // ── 6b. If the Hub produced an LLM summary digest (it holds the Azure key
  //        and rate-limits the call), splice it into the upsert-by-marker MAIN
  //        comment and collapse detail beneath it. When no digest is present,
  //        composeWithDigest is not called and the body is byte-identical to the
  //        deterministic comment. The since-last-commit delta is NOT part of the
  //        main comment — it is posted separately below. The Action makes no LLM
  //        call of its own.
  const hasDigest = typeof blast.aiSummary === 'string' && blast.aiSummary.trim().length > 0;
  const body = hasDigest ? composeWithDigest(rawBody, blast.aiSummary ?? '') : rawBody;

  // ── 7. Post (or update) the MAIN comment — unless this PR comes from a fork.
  //        A fork PR's read-only GITHUB_TOKEN cannot write comments: the attempt
  //        403s and would fail the run AFTER the Hub compute, silently blocking
  //        the fork PR's gate. We degrade to log-only: emit the rendered review
  //        into the step log so the analysis stays visible, skip the write, and
  //        let the gate below run on the Hub data exactly as for a same-repo PR.
  let posted;
  if (isFork) {
    core.info(
      'Fork PR detected — GITHUB_TOKEN is read-only, so the review comment cannot be posted. ' +
        'Running in log-only mode; the rendered review follows and the gate still applies.',
    );
    core.info(body);
  } else {
    try {
      const octokit = github.getOctokit(githubToken);
      posted = await postOrUpdateComment({
        client: asIssueCommentsClient(octokit),
        owner,
        repo,
        prNumber,
        marker: COMMENT_MARKER,
        body,
      });
    } catch (err) {
      // Defense in depth: a 403 the fork precheck did not catch (a restricted
      // same-repo token — e.g. a Dependabot PR, which is NOT a fork but still
      // gets a read-only GITHUB_TOKEN) must never fail the run — the Hub compute
      // and the gate below are the contract. But unlike a fork (an expected,
      // benign case we announce with core.info), a same-repo 403 is usually a
      // real misconfiguration the maintainer should fix, so surface it as an
      // error ANNOTATION (visible, non-failing) with the actionable cause rather
      // than a warning that is easy to miss. Any other error still fails fast.
      if (isForbidden(err)) {
        core.error(
          `Could not post the review comment: ${classifyError(err, 'github')}. ` +
            "If this is a same-repo PR, grant the workflow 'pull-requests: write' " +
            'permission; the gate still ran on the Hub analysis below.',
        );
      } else {
        return fail(err, 'github', 'postOrUpdateComment');
      }
    }
  }

  core.setOutput('blast-level', blast.blastLevel);
  if (posted) {
    core.setOutput('comment-id', String(posted.commentId));
    core.info(`Comment ${posted.action} (id=${posted.commentId}); blast=${blast.blastLevel}.`);
  }

  // ── 6c. Best-effort: when the Hub returned a "since last commit" delta (a PR
  //        re-push), post it as a SEPARATE standalone comment keyed on a per-SHA
  //        marker. Same-SHA re-runs update that one comment (no duplicate); a new
  //        commit (new SHA → new marker) creates a fresh comment, building a
  //        per-commit history in the thread. This is additive: a failure here is
  //        swallowed via classifyError so it can NEVER fail the run, change the
  //        comment-id output, or affect the gate — the main review is the contract.
  //        Skipped entirely on fork PRs (read-only token — same reason as §7).
  const delta = blast.sinceLastCommit;
  if (delta != null && !isFork) {
    try {
      const octokit = github.getOctokit(githubToken);
      const sincePosted = await postOrUpdateComment({
        client: asIssueCommentsClient(octokit),
        owner,
        repo,
        prNumber,
        marker: sinceCommitMarker(delta.headSha),
        body: renderSinceCommitComment(delta),
      });
      core.info(`Since-last-commit comment ${sincePosted.action} (id=${sincePosted.commentId}).`);
    } catch (err) {
      core.warning(`since-last-commit comment skipped: ${classifyError(err, 'github')}`);
    }
  }

  // ── 9. Gate — the only success-path setFailed, evaluated after the
  //        report is posted or logged so reviewers know where to find it.
  const decision = evaluateGate({ blastLevel: blast.blastLevel, threshold });
  core.setOutput('gate-decision', decision);
  if (decision === 'fail') {
    const reportLocation = posted ? 'See PR comment.' : 'See action log.';
    core.setFailed(
      `GitNexus gate: blast level ${blast.blastLevel} meets or exceeds threshold ${threshold}. ${reportLocation}`,
    );
    return;
  }
}

/** SHA shape guard — 7..40 hex. Used to degrade a malformed head sha to undefined. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * @brief: Read the PR head commit SHA from the webhook payload, degrading to
 *         undefined when it is absent or fails the SHA shape guard. Never throws
 *         — a malformed/missing sha simply omits the review anchor for this run.
 *
 * @params: (payload: unknown) -> The GitHub Actions event payload (ctx.payload).
 *
 * @returns: string | undefined — a valid head sha, or undefined to omit the anchor.
 */
function readHeadSha(payload: unknown): string | undefined {
  const sha = (payload as { pull_request?: { head?: { sha?: unknown } } })?.pull_request?.head?.sha;
  return typeof sha === 'string' && SHA_RE.test(sha) ? sha : undefined;
}

/**
 * @brief: Detect a fork PR from the webhook payload. A fork PR's head lives in
 *         a different repository than the base, so the auto-issued GITHUB_TOKEN
 *         is read-only and comment writes 403. Returns true when the head repo
 *         was deleted (`head.repo === null`, GitHub's fork-deleted signal) or its
 *         full_name differs from the base repository's full_name. Never throws.
 *
 *         When either full_name is missing we cannot prove a mismatch and return
 *         false (same-repo): a real pull_request payload always carries both, so
 *         this only affects malformed input, where the 403 hardening in §7 is the
 *         backstop. Erring toward "same-repo" here avoids silently suppressing
 *         the comment on a legitimate PR.
 *
 * @params: (payload: unknown) -> The GitHub Actions event payload (ctx.payload).
 *
 * @returns: boolean — true iff this PR originates from a fork.
 */
function isForkPr(payload: unknown): boolean {
  const p = payload as {
    repository?: { full_name?: unknown };
    pull_request?: { head?: { repo?: { full_name?: unknown } | null } };
  };
  const head = p?.pull_request?.head;
  if (head?.repo === null) return true;
  const headFullName = head?.repo?.full_name;
  const baseFullName = p?.repository?.full_name;
  if (typeof headFullName !== 'string' || typeof baseFullName !== 'string') return false;
  return headFullName !== baseFullName;
}

/**
 * @brief: True when a thrown value is an HTTP 403. Recognises both the axios
 *         shape (`err.response.status`) and the Octokit RequestError shape
 *         (`err.status`). Used to degrade a forbidden comment write to a warning
 *         instead of failing the run (fork PRs, restricted tokens).
 *
 * @params: (err: unknown) -> Thrown value from a comment-post call.
 *
 * @returns: boolean — true iff the error carries a 403 status.
 */
function isForbidden(err: unknown): boolean {
  const e = err as { status?: unknown; response?: { status?: unknown } };
  return e?.status === 403 || e?.response?.status === 403;
}

/**
 * @brief: Translate any thrown value into a user-visible failure via
 *         core.error + core.setFailed. Centralised so the orchestration
 *         body stays readable and so there's a single audit trail for
 *         token-safety: this function never receives the token value.
 *
 * @params: (err: unknown)                        -> Thrown value from a library call.
 * @params: (context: 'hub' | 'github' | 'config') -> Which side raised the error.
 * @params: (stage: string)                        -> Short stage label for the prefix.
 */
function fail(err: unknown, context: 'hub' | 'github' | 'config', stage: string): void {
  const msg = classifyError(err, context);
  const line = `${stage}: ${msg}`;
  core.error(line);
  core.setFailed(line);
}

// Auto-run when invoked as the bundled action entrypoint. Tests import
// the module to call `main` themselves; we suppress the auto-run under
// VITEST so the import is side-effect-free in unit tests.
if (process.env.VITEST !== 'true') {
  main().catch((err: unknown) => {
    // Last-resort guard: any synchronous throw before the try/catch chain
    // (e.g. validateHubUrl, getInput failures) lands here. We must never
    // leak the original error stack as it may contain header / config data.
    const msg = classifyError(err, 'hub');
    core.setFailed(msg);
  });
}
