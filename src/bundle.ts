import * as exec from '@actions/exec';

/**
 * Create a git bundle containing the full history reachable from the
 * PR head, with a local branch ref so the Hub indexer can clone it
 * with `git clone --branch <branchName> <bundle>`.
 *
 * actions/checkout@v6 (with fetch-depth: 0) leaves the workdir with
 * the head SHA detached and the branch only available under
 * `refs/remotes/origin/<branchName>`. `git bundle create --all` would
 * then produce a bundle without `refs/heads/<branchName>`, so the
 * Hub's `git clone --branch` would fail with "Remote branch X not
 * found in upstream origin".
 *
 * Workaround: create a local heads ref pointing at the PR head SHA
 * before bundling. `git update-ref` is non-destructive (it doesn't
 * touch HEAD or the working tree, just creates the ref) and works
 * even when a branch with that name already exists.
 *
 * Earlier we tried `git bundle create <out> <bare-sha>` directly,
 * which fails with "Refusing to create empty bundle" because bundles
 * require ref-like revs to anchor commits. `--all` plus the manual
 * heads ref fixes both sides at once.
 */
export async function createBundle(opts: {
  ref: string;
  branchName: string;
  outPath: string;
  cwd: string;
}): Promise<void> {
  await exec.exec('git', ['update-ref', `refs/heads/${opts.branchName}`, opts.ref], {
    cwd: opts.cwd,
  });
  await exec.exec('git', ['bundle', 'create', opts.outPath, '--all'], { cwd: opts.cwd });
}
