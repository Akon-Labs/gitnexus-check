import { describe, it, expect, vi } from 'vitest';
import { createBundle } from '../src/bundle';
import * as exec from '@actions/exec';

vi.mock('@actions/exec');

describe('createBundle', () => {
  it('runs git bundle create with the given ref and out path', async () => {
    const execMock = vi.mocked(exec.exec).mockResolvedValue(0);
    await createBundle({ ref: 'abc123', outPath: '/tmp/pr.bundle', cwd: '/repo' });
    expect(execMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['bundle', 'create', '/tmp/pr.bundle']),
      { cwd: '/repo' },
    );
    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toEqual(['bundle', 'create', '/tmp/pr.bundle', 'abc123']);
  });
});
