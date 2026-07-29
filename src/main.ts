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
import { asReviewClient, reconcileFindings } from './post-review';
import { renderFallbackSection } from './render-findings';
import { parseThreshold, evaluateGate } from './gate';
import { composeWithDigest, renderSinceCommitComment, sinceCommitMarker } from './slm-format';
import type { FindingItem } from './types/blast-result';

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
 *           7. postOrUpdate   → Octokit upsert by marker (MAIN comment). Always
 *                               ATTEMPTED (a fork may carry write access); a 403
 *                               degrades to log-only (benign info on a fork, loud
 *                               error on a same-repo misconfig) and logs the body.
 *                               Never fails the run on a 403.
 *           6c. sinceLastCommit → if present, post a SEPARATE per-SHA comment;
 *                               best-effort, never fails the run (attempted on forks too).
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

  // Wave-2 inline-findings config. All narrowing-only; empty/unset inputs keep
  // the feature OFF and the pre-Wave-2 behavior byte-identical.
  const findingsCfg = readFindingsConfig();

  // Gated draft-skip (Wave-2 trigger model): when inline findings are enabled
  // AND the PR is still a draft, stay silent until it is marked ready — cubic's
  // behavior. GATED behind inline-findings so existing users see no change (the
  // Action posts the blast comment on drafts today). Exits BEFORE any Hub call.
  if (findingsCfg.enabled && isDraftPr(ctx.payload)) {
    core.info('PR is draft and inline-findings is enabled — skipping review until ready_for_review.');
    return;
  }

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

  // ── 6b. Compose the MAIN comment: the detail sections always collapse into
  //        ONE "Full report" expander, and when the Hub produced an LLM summary
  //        digest (it holds the Azure key and rate-limits the call) it splices
  //        in as the default-visible lead. A missing/failed digest must never
  //        dump every table above the fold — the plain-language verdict + strip
  //        carry the lead instead. The since-last-commit delta is NOT part of
  //        the main comment — it is posted separately below. The Action makes
  //        no LLM call of its own.
  const body = composeWithDigest(rawBody, blast.aiSummary ?? '');

  // ── D1 App-primary gate: when the native GitNexus App bot owns a review surface
  //    for this repo, the Action cedes exactly that surface so the two never
  //    double-post. Per-surface (summary comment + since-last-commit vs inline
  //    findings) so a migration can hand over one at a time. Defaults to false (App
  //    owns nothing) on older Hubs and any malformed value → legacy behavior. The
  //    GATE is unaffected — it is decided from blastLevel alone, below.
  const appOwnsSummary = blast.appReview?.summary === true;
  const appOwnsInlineFindings = blast.appReview?.inlineFindings === true;

  // ── 7. Post (or update) the MAIN comment. We ATTEMPT the write even on a fork:
  //        a fork PR CAN carry write access (pull_request_target, or a configured
  //        write PAT as github-token), so isFork is NOT proof we can't post. We
  //        ATTEMPT the write and, on ANY failure, degrade to log-only — posting
  //        the comment is presentation, and NO comment-post error may fail the
  //        run (doctrine: the gate is the contract, decided from blastLevel
  //        alone below). A fork or a 403 is an expected read-only case (benign
  //        info / actionable permission remedy); any other error (500, rate
  //        limit, network) is a loud but non-failing error annotation. In every
  //        case the rendered review is logged so a failed gate's "See action
  //        log." points at the report.
  let posted;
  if (appOwnsSummary) {
    // The App bot posts the summary comment for this repo — cede it (D1). The gate
    // below still runs; log the rendered review so "See action log." still resolves.
    core.info(
      'GitNexus App bot owns the summary comment for this repo — the Action is not ' +
        'posting it (D1 App-primary). The rendered review follows and the gate still applies.',
    );
    core.info(body);
  } else
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
    // Posting the review comment is PRESENTATION — the Hub compute already
    // succeeded and the gate below decides pass/fail from blastLevel alone. So
    // NO comment-post error ever fails the run (doctrine: comment/findings/fork
    // errors never setFailed; the gate is the contract). We degrade to log-only
    // and continue, tuning only the message: a fork or a 403 is an expected
    // read-only case (benign info / actionable permission remedy); any other
    // error (500, rate-limit, network) is surfaced as a loud error annotation
    // but is still non-failing.
    if (isFork) {
      core.info(
        isForbidden(err)
          ? 'Fork PR detected — GITHUB_TOKEN is read-only, so the review comment cannot be posted. ' +
              'Running in log-only mode; the rendered review follows and the gate still applies.'
          : `Fork PR — could not post the review comment (${classifyError(err, 'github')}). ` +
              'Running in log-only mode; the rendered review follows and the gate still applies.',
      );
    } else if (isForbidden(err)) {
      core.error(
        `Could not post the review comment: ${classifyError(err, 'github')}. ` +
          "If this is a same-repo PR, grant the workflow 'pull-requests: write' " +
          'permission; the gate still ran on the Hub analysis below.',
      );
    } else {
      core.error(
        `Could not post the review comment: ${classifyError(err, 'github')}. ` +
          'The gate still ran on the Hub analysis below; the rendered review follows in the log.',
      );
    }
    // Log the rendered review after any recovered error so a failed gate that
    // says "See action log." actually points at the report (#5).
    core.info(body);
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
  //        Attempted even on fork PRs (a fork may carry write access); a read-only
  //        403 is swallowed into a warning like any other failure — never pre-skipped.
  //        The since-last-commit comment is part of the SUMMARY surface, so it is
  //        also ceded when the App owns the summary (D1) — the App posts its own
  //        per-push delta comment.
  const delta = blast.sinceLastCommit;
  if (delta != null && !appOwnsSummary) {
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

  // ── 6d. Best-effort inline findings (Wave 2). Posts line-anchored review
  //        comments for anchored findings and demotes the rest into a fallback
  //        section appended to the MAIN comment. This runs AFTER the main comment
  //        and BEFORE the gate, and is strictly best-effort: any failure is
  //        swallowed so it can NEVER fail the run or affect the gate (the gate
  //        reads blastLevel only). The two outputs are set ALWAYS (0 when off).
  //        Attempted even on fork PRs (a fork may carry write access); a read-only
  //        403 degrades — reconcile returns the findings as failed and the fallback
  //        post is swallowed — rather than being pre-skipped. Skipped entirely when
  //        the input is off, when the Hub sent no findings envelope, or when the Hub
  //        reported a findings error — in every skip case the main comment stays
  //        byte-identical.
  let inlinePosted = 0;
  let inlineSuppressed = 0;
  const findings = blast.findings;
  // Freshness guard: findings compute ASYNC on the Hub, so a quick re-push can
  // make getBlast return the PRIOR commit's findings (findings.analyzedSha = A)
  // while this run's head is B. Posting A's findings — anchored to A's lines and
  // pinned to commit A — onto B would be wrong, so skip inline posting when the
  // envelope was computed for a different head; the next push's compute catches
  // up. Only compare when BOTH shas are known (older Hubs omit analyzedSha).
  const findingsFresh =
    findings == null ||
    findings.analyzedSha == null ||
    headSha == null ||
    findings.analyzedSha === headSha;
  if (!findingsFresh) {
    core.info(
      `Inline findings skipped: the Hub findings envelope is for ${findings!.analyzedSha}, ` +
        `not the current head ${headSha}. They will post once the Hub finishes analyzing this commit.`,
    );
  }
  if (appOwnsInlineFindings && findingsCfg.enabled && findings != null) {
    // The App bot posts inline review-comment findings for this repo — cede the
    // whole inline surface (D1) so the two never double-post. Best-effort/gate
    // unaffected; the inline outputs stay 0 (the Action posted none).
    core.info('GitNexus App bot owns inline findings for this repo — the Action is not posting them (D1 App-primary).');
  }
  if (
    !appOwnsInlineFindings &&
    findingsCfg.enabled &&
    findingsFresh &&
    findings != null &&
    findings.error === null
  ) {
    try {
      const narrowed = narrowFindings(findings.items, findingsCfg);
      inlineSuppressed = findings.suppressedCount + narrowed.suppressed;
      const reconcile = await reconcileFindings({
        client: asReviewClient(github.getOctokit(githubToken)),
        owner,
        repo,
        prNumber,
        analyzedSha: findings.analyzedSha,
        items: narrowed.inline,
      });
      inlinePosted = reconcile.posted + reconcile.updated;

      // Findings that couldn't be line-anchored, plus any that failed to post,
      // render in the demoted fallback section of the MAIN comment. We only
      // re-post (update) the main comment when there is something to demote, so
      // the byte-identical main comment is preserved when there is not.
      const fallbackItems = [...narrowed.demoted, ...reconcile.failed];
      if (fallbackItems.length > 0 || findings.truncated) {
        let section = renderFallbackSection(fallbackItems);
        // Surface the Hub's time-box marker — partial results must never
        // read as complete ones.
        if (findings.truncated) {
          const note = '_The findings stage hit its time budget — results may be partial._';
          section = section ? `${section}\n\n${note}` : note;
        }
        const composed = `${body.trimEnd()}\n\n${section}\n`;
        if (section && composed.length <= GITHUB_COMMENT_HARD_CAP) {
          // Reuse §7's comment id when we have it — re-listing the thread to
          // rediscover our own comment is wasted API budget and a needless
          // race window on busy PRs.
          if (posted) {
            const octokit = github.getOctokit(githubToken);
            await octokit.rest.issues.updateComment({
              owner,
              repo,
              comment_id: posted.commentId,
              body: composed,
            });
          } else if (!appOwnsSummary) {
            // The main-comment post FAILED (fork/403) but we may still have write
            // access — best-effort fresh post carrying the demoted findings.
            await postOrUpdateComment({
              client: asIssueCommentsClient(github.getOctokit(githubToken)),
              owner,
              repo,
              prNumber,
              marker: COMMENT_MARKER,
              body: composed,
            });
          } else {
            // D1: the App owns the summary comment (COMMENT_MARKER). Re-posting the
            // full summary body here to carry the fallback would DOUBLE-POST the very
            // surface we just ceded. Do not post — log the demoted section so it
            // stays visible; surfacing it belongs to the App's comment.
            core.info(
              'GitNexus App bot owns the summary comment — the Action is not re-posting it to ' +
                'carry the non-inline findings (D1). They follow in the log:',
            );
            core.info(section);
          }
        }
      }
    } catch (err) {
      core.warning(`inline-findings skipped: ${classifyError(err, 'github')}`);
    }
  }
  core.setOutput('inline-findings-posted', String(inlinePosted));
  core.setOutput('inline-findings-suppressed', String(inlineSuppressed));

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
 * GitHub's hard cap on an issue-comment body is 65,536 chars. The main comment
 * targets CHAR_BUDGET (60,000), leaving headroom for an appended fallback
 * section; we still guard the composed length so a pathological case skips the
 * append rather than 422-ing the update.
 */
const GITHUB_COMMENT_HARD_CAP = 65_000;

/**
 * @brief: Read the Wave-2 inline-findings inputs, all narrowing-only. Defaults
 *         (empty inputs, as in unit tests) keep the feature OFF: `enabled` false,
 *         `maxItems` 10, `severityFloor` 'warning'. `max-inline-findings` is
 *         clamped to a positive integer; `inline-severity-floor` accepts only
 *         'error' to raise the floor, anything else (incl. '') stays 'warning'.
 *
 * @returns: { enabled, maxItems, severityFloor } — the resolved findings config.
 */
function readFindingsConfig(): {
  enabled: boolean;
  maxItems: number;
  severityFloor: 'warning' | 'error';
} {
  const enabled = core.getInput('inline-findings').trim().toLowerCase() === 'true';
  const parsedMax = Number.parseInt(core.getInput('max-inline-findings').trim(), 10);
  const maxItems = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 10;
  const severityFloor =
    core.getInput('inline-severity-floor').trim().toLowerCase() === 'error' ? 'error' : 'warning';
  return { enabled, maxItems, severityFloor };
}

/** True when the PR payload marks this PR as a draft. Never throws. */
function isDraftPr(payload: unknown): boolean {
  return (payload as { pull_request?: { draft?: unknown } })?.pull_request?.draft === true;
}

/** Total order over finding severities so a floor comparison is a numeric `>=`. */
function severityRank(severity: 'warning' | 'error'): number {
  return severity === 'error' ? 1 : 0;
}

/**
 * @brief: Narrow a Hub findings list by the Action's severity floor and inline
 *         cap (narrowing-only — never surfaces more than the Hub sent). Splits
 *         the floor-passing items into the anchored set to post inline (capped)
 *         and the demoted set (anchored:false) for the fallback section, and
 *         counts what the Action suppressed (below-floor + over-cap) so the
 *         caller can add it to the Hub's suppressedCount.
 *
 * @params: (items) -> The normalised Hub findings items.
 * @params: (cfg)   -> { maxItems, severityFloor }.
 * @returns: { inline, demoted, suppressed } — inline posts, fallback items, suppressed count.
 */
function narrowFindings(
  items: FindingItem[],
  cfg: { maxItems: number; severityFloor: 'warning' | 'error' },
): { inline: FindingItem[]; demoted: FindingItem[]; suppressed: number } {
  const floor = severityRank(cfg.severityFloor);
  const afterFloor = items.filter((it) => severityRank(it.severity) >= floor);
  const floorSuppressed = items.length - afterFloor.length;

  const anchored = afterFloor.filter((it) => it.anchored && it.anchor != null);
  const demoted = afterFloor.filter((it) => !(it.anchored && it.anchor != null));
  const inline = anchored.slice(0, cfg.maxItems);
  // Over-cap anchored items DEMOTE to the fallback section rather than
  // vanish — the narrowing knob bounds inline noise, it must not hide
  // findings entirely.
  const overCap = anchored.slice(cfg.maxItems);

  return { inline, demoted: [...demoted, ...overCap], suppressed: floorSuppressed };
}

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
