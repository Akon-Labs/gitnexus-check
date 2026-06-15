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

/**
 * @brief: Top-level orchestration. Sequence:
 *           1. Read inputs + validate event shape (non-PR → warn + exit 0).
 *           2. parseThreshold → validate fail-on-blast-level (bad → fail fast).
 *           3. resolveRepoId  → Hub UUID for owner/repo.
 *           4. refreshBlast   → POST /refresh (synchronous on the live Hub).
 *           5. getBlast       → GET /prs/:n; validated by isBlastResult.
 *           6. renderComment  → markdown ≤ CHAR_BUDGET.
 *           7. postOrUpdate   → Octokit upsert by marker.
 *           8. setOutput      → comment-id, blast-level, gate-decision.
 *           9. evaluateGate   → setFailed iff blast level meets/exceeds threshold.
 *
 *         Every Hub call wraps in try/catch → classifyError('hub'); every
 *         GitHub call wraps similarly with 'github' context. The gate is the
 *         only setFailed driven by a successful run and fires AFTER the
 *         comment is posted. On any thrown classified message we call
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
    await refreshBlast({ hubUrl, token, repoId, prNumber });
  } catch (err) {
    return fail(err, 'hub', 'refreshBlast');
  }

  let blast;
  try {
    blast = await getBlast({ hubUrl, token, repoId, prNumber });
  } catch (err) {
    return fail(err, 'hub', 'getBlast');
  }

  const body = renderComment(blast, { prNumber, hubUrl });

  let posted;
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
    return fail(err, 'github', 'postOrUpdateComment');
  }

  core.setOutput('comment-id', String(posted.commentId));
  core.setOutput('blast-level', blast.blastLevel);
  core.info(`Comment ${posted.action} (id=${posted.commentId}); blast=${blast.blastLevel}.`);

  // ── 9. Gate — the only success-path setFailed, evaluated after the
  //        comment is posted so reviewers always have the report.
  const decision = evaluateGate({ blastLevel: blast.blastLevel, threshold });
  core.setOutput('gate-decision', decision);
  if (decision === 'fail') {
    core.setFailed(
      `GitNexus gate: blast level ${blast.blastLevel} meets or exceeds threshold ${threshold}. See PR comment.`,
    );
    return;
  }
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
