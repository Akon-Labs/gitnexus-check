import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import pc from 'picocolors';
import { createBundle } from './bundle';
import { uploadBundle, pollUntilReady } from './upload';
import { computeDiffStats, shouldReindex } from './diff';
import { fetchContextPack, resolveRepoId } from './context-pack';
import { renderArtifacts } from './render';

/**
 * Phase 2 (Action — Claude-led prep) entrypoint.
 *
 * Flow:
 *   1. Validate event + read inputs.
 *   2. Resolve repoId on the Hub.
 *   3. Compute diff stats locally (numstat + name-status).
 *   4. Decide whether to reindex (lazy path skips for small diffs).
 *   5. If reindexing: bundle HEAD, upload, poll status.
 *   6. POST to /context-pack and receive Context Pack JSON.
 *   7. Render artifacts (context-pack.json, system-prompt.md, MCP config).
 *   8. Set step outputs for the Claude action step.
 *
 * Exit codes:
 *   - 0 on success or known-skip paths (non-PR event).
 *   - 1 on any unexpected error (core.setFailed).
 */
export async function main(): Promise<void> {
  // hub-url is required in action.yml — no fallback default. We strip
  // any trailing slash so callers can pass `https://hub.gitnexus.io/`
  // or `https://hub.gitnexus.io` interchangeably.
  const hubUrl = core.getInput('hub-url', { required: true }).replace(/\/+$/, '');
  const token = core.getInput('token', { required: true });
  const deepReviewLabel = core.getInput('deep-review-label') || 'gitnexus-deep-review';
  const lazyReindexInput = (core.getInput('lazy-reindex') || 'true').toLowerCase();
  const lazyReindex = lazyReindexInput !== 'false';

  const ctx = github.context;
  if (ctx.eventName !== 'pull_request' && ctx.eventName !== 'pull_request_target') {
    core.warning(
      `gitnexus prep only runs on pull_request events; got "${ctx.eventName}". Skipping.`,
    );
    return;
  }

  const pr = ctx.payload.pull_request;
  if (!pr) {
    core.warning('pull_request payload missing — skipping prep step.');
    return;
  }

  const prNumber: number = pr.number;
  const branchName: string = pr.head.ref;
  const headSha: string = pr.head.sha;
  const baseSha: string = pr.base.sha;
  const prUrl: string | null = pr.html_url ?? null;
  const repoFullName = `${ctx.repo.owner}/${ctx.repo.repo}`;
  const labels: string[] = Array.isArray(pr.labels)
    ? pr.labels.map((l: { name?: string }) => l.name ?? '').filter(Boolean)
    : [];
  const hasDeepReviewLabel = labels.includes(deepReviewLabel);

  core.info(pc.bold(pc.cyan(`GitNexus prep — PR #${prNumber} (${repoFullName})`)));
  core.info(`  branch: ${branchName}`);
  core.info(`  head:   ${headSha}`);
  core.info(`  base:   ${baseSha}`);
  if (labels.length) core.info(`  labels: ${labels.join(', ')}`);

  // ── 1. Resolve repo on Hub ──
  core.startGroup('Resolving repo on Hub');
  const repoId = await resolveRepoId({ hubUrl, token, fullName: repoFullName });
  core.info(`  repoId = ${repoId}`);
  core.endGroup();

  // ── 2. Diff stats ──
  core.startGroup('Computing diff stats');
  const diffStats = await computeDiffStats({
    baseSha,
    headSha,
    cwd: process.cwd(),
  });
  core.info(
    `  files: ${diffStats.filesChanged}, +${diffStats.linesAdded}/-${diffStats.linesDeleted}, ` +
      `rename: ${diffStats.hasRename}, big: ${diffStats.isBigDiff}`,
  );
  core.endGroup();

  // ── 3. Decide reindex strategy ──
  const reindex = shouldReindex(diffStats, { hasDeepReviewLabel, lazyReindex });
  core.info(
    reindex
      ? pc.yellow(
          `  → full reindex (${
            !lazyReindex
              ? 'lazy disabled'
              : hasDeepReviewLabel
                ? `label "${deepReviewLabel}" present`
                : diffStats.hasRename
                  ? 'diff contains rename'
                  : 'big diff (>50 files)'
          })`,
        )
      : pc.green('  → lazy path — using main-graph + raw diff'),
  );

  let indexedCommit: string | null = null;
  if (reindex) {
    core.startGroup('Bundling + uploading PR head');
    const bundlePath = path.join(os.tmpdir(), `gitnexus-pr-${prNumber}.bundle`);
    await createBundle({
      ref: headSha,
      branchName,
      outPath: bundlePath,
      cwd: process.cwd(),
    });
    core.info(`  bundle: ${bundlePath}`);

    const uploaded = await uploadBundle({
      hubUrl,
      token,
      repoId,
      prNumber,
      branchName,
      bundlePath,
    });
    core.info(`  upload accepted (status=${uploaded.status})`);

    const ready = await pollUntilReady({
      statusUrl: uploaded.statusUrl,
      hubUrl,
      token,
    });
    indexedCommit = ready.indexedCommit;
    core.info(pc.green(`  indexed commit: ${indexedCommit}`));

    // Best-effort cleanup of the local bundle file.
    fs.rm(bundlePath, { force: true }, () => {});
    core.endGroup();
  }

  // ── 4. Context Pack ──
  core.startGroup('Fetching Context Pack from Hub');
  // Always include diff.files. We only attach the raw diff when lazy
  // (no reindex) AND the file list is non-empty — the Hub builder
  // prefers the structured files list over the raw diff and only falls
  // back to rawDiff when files is empty (e.g. fork PRs without base
  // SHA access).
  const contextPack = await fetchContextPack({
    hubUrl,
    token,
    repoId,
    request: {
      prNumber,
      headSha,
      baseSha,
      branch: branchName,
      url: prUrl,
      diff: {
        files: diffStats.files,
      },
    },
  });
  const warnings = Array.isArray(contextPack.warningsForClaude)
    ? contextPack.warningsForClaude
    : [];
  if (warnings.length) {
    core.info(pc.yellow(`  Context Pack warnings (${warnings.length}):`));
    for (const w of warnings) core.info(`    - ${w}`);
  } else {
    core.info('  Context Pack received (no warnings).');
  }
  core.endGroup();

  // ── 5. Render artifacts ──
  core.startGroup('Writing artifacts');
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const rendered = renderArtifacts({
    workspace,
    contextPack,
    hubUrl,
    token,
    repoFullName,
    prNumber,
  });
  core.info(`  context-pack.json  → ${rendered.contextPackPath}`);
  core.info(`  system-prompt.md   → ${rendered.systemPromptPath}`);
  core.info(`  gitnexus-mcp.json  → ${rendered.mcpConfigPath}`);
  core.endGroup();

  // ── 6. Step outputs ──
  core.setOutput('context-pack-path', rendered.contextPackPath);
  core.setOutput('system-prompt-path', rendered.systemPromptPath);
  core.setOutput('mcp-config-path', rendered.mcpConfigPath);
  if (indexedCommit) core.setOutput('indexed-commit', indexedCommit);

  core.info(pc.bold(pc.green('GitNexus prep complete.')));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.setFailed(`gitnexus prep failed: ${msg}`);
});
