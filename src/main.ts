import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'node:path';
import * as os from 'node:os';
import { createBundle } from './bundle';
import { uploadBundle, pollUntilReady, runChecks } from './upload';
import { findCoverageFile, uploadCoverage } from './coverage';
import {
  composeMarkdown,
  findMarkerComment,
  type PipelineStage,
  type CoverageMetric,
} from './comment';

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

  // Track per-stage timing for the dashboard's Pipeline Status table.
  // Each stage records its duration + outcome so the comment can render
  // a clear breakdown of where time went and what failed.
  const pipeline: PipelineStage[] = [];
  let coverage: CoverageMetric[] | undefined;

  // ── Stage: indexing (bundle + reindex + poll) ──
  const tIndexStart = Date.now();
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
  pipeline.push({
    name: 'Indexing',
    status: 'success',
    details: `\`${ready.indexedCommit.slice(0, 7)}\` indexed in ${((Date.now() - tIndexStart) / 1000).toFixed(1)}s`,
  });

  // ── Stage: coverage upload (optional) ──
  const coverageInput = core.getInput('coverage-file') || undefined;
  const coverageFormat = core.getInput('coverage-format') || 'auto';
  const coveragePath = findCoverageFile(process.cwd(), coverageInput);
  if (coveragePath) {
    core.info(`Uploading coverage from ${coveragePath}`);
    const tCovStart = Date.now();
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
      pipeline.push({
        name: 'Coverage',
        status: 'success',
        details: `${upload.format}, ${upload.filesCount} file${upload.filesCount === 1 ? '' : 's'} in ${((Date.now() - tCovStart) / 1000).toFixed(1)}s`,
      });
      // Single-metric (lines) coverage row for the dashboard. Multi-metric
      // (branches/functions/statements) requires a richer parser response
      // and the Hub returning per-metric aggregates — tracked separately.
      coverage = [
        {
          metric: 'Lines',
          covered: upload.hitLinesCount,
          total: upload.hitLinesCount + upload.missedLinesCount,
        },
      ];
    } catch (err) {
      // Non-fatal — coverage-gap check just falls back to its no-op
      // pass. We surface the error as a warning so the user can
      // diagnose without the whole action failing.
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Coverage upload failed: ${msg}`);
      pipeline.push({
        name: 'Coverage',
        status: 'failure',
        details: `upload failed: ${msg.slice(0, 60)}`,
      });
    }
  } else if (coverageInput) {
    core.warning(`coverage-file input set to "${coverageInput}" but file not found — skipping`);
    pipeline.push({
      name: 'Coverage',
      status: 'skipped',
      details: `coverage-file: \`${coverageInput}\` not found`,
    });
  } else {
    core.info('No coverage file found in common paths — skipping (set coverage-file: to enable)');
    pipeline.push({
      name: 'Coverage',
      status: 'skipped',
      details: 'no coverage file detected — set `coverage-file` to enable',
    });
  }

  // ── Stage: graph checks ──
  core.info('Running check suite');
  const tChecksStart = Date.now();
  const suite = await runChecks({ hubUrl, token, repoId, prNumber });
  const failingCount = suite.checks.filter((c) => c.severity === 'fail').length;
  pipeline.push({
    name: 'Graph checks',
    status: failingCount > 0 ? 'failure' : 'success',
    details: `${suite.checks.length} checks ran in ${((Date.now() - tChecksStart) / 1000).toFixed(1)}s`,
  });

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
    pipeline,
    coverage,
  });
  core.setOutput('checks-json', JSON.stringify(suite.checks));
  core.setOutput('summary-markdown', markdown);

  if (postComment) {
    // Pull from the `github-token` input first (defaults to `${{ github.token }}`
    // in action.yml — auto-resolves to the workflow's GITHUB_TOKEN as long as
    // the workflow has `permissions: pull-requests: write`). Fall back to the
    // env var for back-compat with workflows pinned to older action versions.
    const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN;
    if (!githubToken) {
      core.warning('github-token input + GITHUB_TOKEN env both empty — skipping PR comment');
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
  const match = repos.find((r) => r.fullName === opts.fullName || r.full_name === opts.fullName);
  if (!match) throw new Error(`repo ${opts.fullName} not registered on Hub`);
  return match.id;
}

main().catch((e) => core.setFailed(String(e)));
