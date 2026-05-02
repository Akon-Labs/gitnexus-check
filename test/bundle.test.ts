import { describe, it, expect, vi } from 'vitest';
import { createBundle } from '../src/bundle';
import * as exec from '@actions/exec';

vi.mock('@actions/exec');

describe('createBundle', () => {
  it('creates a refs/heads ref then bundles --all', async () => {
    // The Hub indexer clones the bundle with `git clone --branch <name>`,
    // which only resolves refs under refs/heads. actions/checkout@v6
    // leaves the workdir in detached HEAD with the branch only under
    // refs/remotes/origin/<name>, so we manually create the heads ref
    // before bundling. Then bundle --all so every ref the runner has
    // (including the freshly-created one) lands in the bundle.
    const execMock = vi.mocked(exec.exec).mockResolvedValue(0);
    await createBundle({
      ref: 'abc123',
      branchName: 'feat/foo',
      outPath: '/tmp/pr.bundle',
      cwd: '/repo',
    });
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['update-ref', 'refs/heads/feat/foo', 'abc123'],
      { cwd: '/repo' },
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['bundle', 'create', '/tmp/pr.bundle', '--all'],
      { cwd: '/repo' },
    );
  });
});
