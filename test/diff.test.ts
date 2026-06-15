import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDiff, shouldReindex, BIG_DIFF_FILE_THRESHOLD } from '../src/diff';

// computeDiffStats shells out to git via @actions/exec. Mock the module
// so the partial-output / total-failure behaviours can be exercised
// deterministically without a real git invocation.
vi.mock('@actions/exec', () => ({ exec: vi.fn() }));

describe('parseDiff', () => {
  it('parses simple modified files', () => {
    const numstat = '12\t3\tsrc/a.ts\n0\t5\tsrc/b.ts\n';
    const nameStatus = 'M\tsrc/a.ts\nM\tsrc/b.ts\n';
    const r = parseDiff(numstat, nameStatus);
    expect(r.filesChanged).toBe(2);
    expect(r.linesAdded).toBe(12);
    expect(r.linesDeleted).toBe(8);
    expect(r.hasRename).toBe(false);
    expect(r.isBigDiff).toBe(false);
    expect(r.files).toEqual([
      { path: 'src/a.ts', status: 'modified', added: 12, deleted: 3 },
      { path: 'src/b.ts', status: 'modified', added: 0, deleted: 5 },
    ]);
  });

  it('detects added and removed files', () => {
    const numstat = '50\t0\tsrc/new.ts\n0\t30\tsrc/old.ts\n';
    const nameStatus = 'A\tsrc/new.ts\nD\tsrc/old.ts\n';
    const r = parseDiff(numstat, nameStatus);
    expect(r.files).toEqual([
      { path: 'src/new.ts', status: 'added', added: 50, deleted: 0 },
      { path: 'src/old.ts', status: 'removed', added: 0, deleted: 30 },
    ]);
  });

  it('detects renames from name-status R<score>', () => {
    // git emits "R100\told\tnew" and numstat usually emits the new path
    // alone with "<a>\t<d>\t<new>" (or 4-part with old+new). We test
    // the common 3-part numstat case.
    const numstat = '5\t2\tsrc/new.ts\n';
    const nameStatus = 'R100\tsrc/old.ts\tsrc/new.ts\n';
    const r = parseDiff(numstat, nameStatus);
    expect(r.hasRename).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({
      path: 'src/new.ts',
      status: 'renamed',
      previousPath: 'src/old.ts',
    });
  });

  it('detects renames from 4-part numstat row', () => {
    const numstat = '5\t2\tsrc/old.ts\tsrc/new.ts\n';
    const nameStatus = 'R100\tsrc/old.ts\tsrc/new.ts\n';
    const r = parseDiff(numstat, nameStatus);
    expect(r.hasRename).toBe(true);
    expect(r.files[0]?.previousPath).toBe('src/old.ts');
    expect(r.files[0]?.path).toBe('src/new.ts');
  });

  it('treats binary files (- - path) as zero line counts', () => {
    const numstat = '-\t-\timg/logo.png\n';
    const nameStatus = 'M\timg/logo.png\n';
    const r = parseDiff(numstat, nameStatus);
    expect(r.files).toEqual([{ path: 'img/logo.png', status: 'modified', added: 0, deleted: 0 }]);
    expect(r.linesAdded).toBe(0);
    expect(r.linesDeleted).toBe(0);
  });

  it('marks isBigDiff when files exceed threshold', () => {
    const lines: string[] = [];
    const status: string[] = [];
    for (let i = 0; i <= BIG_DIFF_FILE_THRESHOLD; i++) {
      lines.push(`1\t1\tsrc/f${i}.ts`);
      status.push(`M\tsrc/f${i}.ts`);
    }
    const r = parseDiff(lines.join('\n') + '\n', status.join('\n') + '\n');
    expect(r.filesChanged).toBe(BIG_DIFF_FILE_THRESHOLD + 1);
    expect(r.isBigDiff).toBe(true);
  });

  it('does NOT mark isBigDiff for exactly threshold files', () => {
    const lines: string[] = [];
    const status: string[] = [];
    for (let i = 0; i < BIG_DIFF_FILE_THRESHOLD; i++) {
      lines.push(`1\t1\tsrc/f${i}.ts`);
      status.push(`M\tsrc/f${i}.ts`);
    }
    const r = parseDiff(lines.join('\n') + '\n', status.join('\n') + '\n');
    expect(r.filesChanged).toBe(BIG_DIFF_FILE_THRESHOLD);
    expect(r.isBigDiff).toBe(false);
  });

  it('handles empty input', () => {
    const r = parseDiff('', '');
    expect(r.filesChanged).toBe(0);
    expect(r.linesAdded).toBe(0);
    expect(r.linesDeleted).toBe(0);
    expect(r.hasRename).toBe(false);
    expect(r.isBigDiff).toBe(false);
    expect(r.files).toEqual([]);
  });
});

describe('shouldReindex', () => {
  const small = { hasRename: false, isBigDiff: false };
  const renamed = { hasRename: true, isBigDiff: false };
  const big = { hasRename: false, isBigDiff: true };

  it('skips reindex on small diff with no label', () => {
    expect(shouldReindex(small, { hasDeepReviewLabel: false, lazyReindex: true })).toBe(false);
  });

  it('reindexes when deep-review label is present', () => {
    expect(shouldReindex(small, { hasDeepReviewLabel: true, lazyReindex: true })).toBe(true);
  });

  it('reindexes when diff has rename', () => {
    expect(shouldReindex(renamed, { hasDeepReviewLabel: false, lazyReindex: true })).toBe(true);
  });

  it('reindexes when diff is big', () => {
    expect(shouldReindex(big, { hasDeepReviewLabel: false, lazyReindex: true })).toBe(true);
  });

  it('always reindexes when lazy is disabled', () => {
    expect(shouldReindex(small, { hasDeepReviewLabel: false, lazyReindex: false })).toBe(true);
  });
});

describe('computeDiffStats — partial output handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('falls back to big-diff when --numstat fails outright', async () => {
    const { computeDiffStats } = await import('../src/diff');
    const exec = await import('@actions/exec');
    (exec.exec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('git not found');
    });

    const stats = await computeDiffStats({ baseSha: 'a', headSha: 'b', cwd: '.' });
    expect(stats.isBigDiff).toBe(true);
    expect(stats.filesChanged).toBe(0);
    expect(stats.files).toEqual([]);
  });

  it('preserves numstat data when --name-status fails (no spurious big-diff fallback)', async () => {
    const { computeDiffStats } = await import('../src/diff');
    const exec = await import('@actions/exec');

    let call = 0;
    (exec.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _cmd: string,
        args: string[],
        opts: { listeners?: { stdout?: (b: Buffer) => void } },
      ) => {
        call += 1;
        if (args.includes('--numstat')) {
          // Emit one modified-file row.
          opts.listeners?.stdout?.(Buffer.from('5\t2\tsrc/foo.ts\n'));
          return 0;
        }
        if (args.includes('--name-status')) {
          throw new Error('name-status exploded');
        }
        return 0;
      },
    );

    const stats = await computeDiffStats({ baseSha: 'a', headSha: 'b', cwd: '.' });
    // numstat data survives — we don't drop to the big-diff fallback.
    expect(stats.filesChanged).toBe(1);
    expect(stats.linesAdded).toBe(5);
    expect(stats.linesDeleted).toBe(2);
    expect(stats.isBigDiff).toBe(false);
    // hasRename can't be derived without name-status; defaults to false.
    expect(stats.hasRename).toBe(false);
    expect(call).toBe(2);
  });

  it('produces full output when both git commands succeed', async () => {
    const { computeDiffStats } = await import('../src/diff');
    const exec = await import('@actions/exec');

    (exec.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _cmd: string,
        args: string[],
        opts: { listeners?: { stdout?: (b: Buffer) => void } },
      ) => {
        if (args.includes('--numstat')) {
          opts.listeners?.stdout?.(Buffer.from('10\t3\tsrc/a.ts\n4\t1\tsrc/b.ts\n'));
          return 0;
        }
        if (args.includes('--name-status')) {
          opts.listeners?.stdout?.(Buffer.from('M\tsrc/a.ts\nM\tsrc/b.ts\n'));
          return 0;
        }
        return 0;
      },
    );

    const stats = await computeDiffStats({ baseSha: 'a', headSha: 'b', cwd: '.' });
    expect(stats.filesChanged).toBe(2);
    expect(stats.linesAdded).toBe(14);
    expect(stats.linesDeleted).toBe(4);
    expect(stats.hasRename).toBe(false);
  });
});
