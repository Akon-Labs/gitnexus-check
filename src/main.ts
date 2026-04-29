import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'node:path';
import * as os from 'node:os';
import { createBundle } from './bundle';
import { uploadBundle, pollUntilReady, runChecks } from './upload';
import { findCoverageFile, uploadCoverage } from './coverage';
import { composeMarkdown, findMarkerComment } from './comment';

async function main() {
  const hubUrl = core.getInput('hub-url');
  const token = core.getInput('token', { required: true });
  const postComment = core.getInput('pr-comment') !== 'false';

  const ctx = github.context;
  if (ctx.eventName !== 'pull_request') {
    core.warning(`Action only supports pull_request events, got ${ctx.eventName}`);
    return;
  }

  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.warning('pull_request payload missing');
    return;
  }

  const prNumber: number = pr.number;
  const branchName: string = pr.head.ref;
  const headSha: string = pr.head.sha;
  const repoFullName = `${ctx.repo.owner}/${ctx.repo.repo}`;

  const repoId = await resolveRepoId({ hubUrl, token, fullName: repoFullName });

  const bundlePath = path.join(os.tmpdir(), `gitnexus-pr-${prNumber}.bundle`);
  core.info(`Creating bundle for ${headSha}`);
  await createBundle({
    ref: headSha,
    branchName,
    outPath: bundlePath,
    cwd: process.cwd(),
  });

  core.info('Uploading bundle to Hub');
  const reindex = await uploadBundle({
    hubUrl,
    token,
    repoId,
    prNumber,
    branchName,
    bundlePath,
  });

  core.info('Waiting for indexing');
  const ready = await pollUntilReady({ statusUrl: reindex.statusUrl, hubUrl, token });
  core.info(`Indexed commit: ${ready.indexedCommit}`);

  // Phase 15: optional coverage upload. Auto-detect from common
  // paths if `coverage-file` input is omitted. Silent skip when
  // nothing is found — the coverage-gap check no-ops in that case
  // with an instructional summary, and we don't want to fail the
  // action just because a repo hasn't wired coverage yet.
  const coverageInput = core.getInput('coverage-file') || undefined;
  const coverageFormat = core.getInput('coverage-format') || 'auto';
  const coveragePath = findCoverageFile(process.cwd(), coverageInput);
  if (coveragePath) {
    core.info(`Uploading coverage from ${coveragePath}`);
    try {
      const upload = await uploadCoverage({
        hubUrl,
        token,
        repoId,
        prNumber,
        commitSha: headSha,
        coveragePath,
        format: coverageFormat,
      });
      core.info(
        `Coverage uploaded: format=${upload.format}, files=${upload.filesCount}, hit=${upload.hitLinesCount}, missed=${upload.missedLinesCount}`,
      );
    } catch (err) {
      // Non-fatal — coverage-gap check just falls back to its no-op
      // pass. We surface the error as a warning so the user can
      // diagnose without the whole action failing.
      core.warning(`Coverage upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (coverageInput) {
    core.warning(`coverage-file input set to "${coverageInput}" but file not found — skipping`);
  } else {
    core.info('No coverage file found in common paths — skipping (set coverage-file: to enable)');
  }

  core.info('Running check suite');
  const suite = await runChecks({ hubUrl, token, repoId, prNumber });

  const markdown = composeMarkdown({
    ...suite,
    branch: branchName,
    commitSha: headSha,
    indexedCommit: ready.indexedCommit,
    repoFullName,
    // Phase 13: render per-check "Fix with Claude →" links only when the
    // user has opted into the Claude workflow on this repo. The flag is
    // sourced from the Hub's checks response (`repo.claudeEnabled`) so
    // the action doesn't need a second round-trip.
    claudeEnabled: suite.repo?.claudeEnabled === true,
  });
  core.setOutput('checks-json', JSON.stringify(suite.checks));
  core.setOutput('summary-markdown', markdown);

  if (postComment) {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.warning('GITHUB_TOKEN not set — skipping PR comment');
    } else {
      const octokit = github.getOctokit(githubToken);
      const { data: comments } = await octokit.rest.issues.listComments({
        ...ctx.repo,
        issue_number: prNumber,
      });
      const existing = findMarkerComment(comments);
      if (existing) {
        await octokit.rest.issues.updateComment({
          ...ctx.repo,
          comment_id: existing.id,
          body: markdown,
        });
      } else {
        await octokit.rest.issues.createComment({
          ...ctx.repo,
          issue_number: prNumber,
          body: markdown,
        });
      }
    }
  }

  const hasFail = suite.checks.some((c) => c.severity === 'fail');
  if (hasFail) core.setFailed('GitNexus checks failed');
}

async function resolveRepoId(opts: {
  hubUrl: string;
  token: string;
  fullName: string;
}): Promise<string> {
  const axios = (await import('axios')).default;
  const res = await axios.get(`${opts.hubUrl}/api/repos`, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  // The Hub returns `fullName` (camelCase); some older deployments
  // returned `full_name` (snake_case). Accept both so the action keeps
  // working against either response shape.
  const repos: Array<{ id: string; fullName?: string; full_name?: string }> =
    res.data.repos ?? res.data;
  const match = repos.find(
    (r) => r.fullName === opts.fullName || r.full_name === opts.fullName,
  );
  if (!match) throw new Error(`repo ${opts.fullName} not registered on Hub`);
  return match.id;
}

main().catch((e) => core.setFailed(String(e)));
