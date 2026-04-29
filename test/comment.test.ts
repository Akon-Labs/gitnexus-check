import { describe, it, expect } from 'vitest';
import { composeMarkdown, findMarkerComment, MARKER } from '../src/comment';
import { CLAUDE_COMMANDS } from '../src/claude-commands';

describe('composeMarkdown', () => {
  it('renders pass-only', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc123def',
      indexedCommit: 'abc123def',
      durationMs: 4200,
      warRoomUrl: 'http://x/prs/42',
      branch: 'feat/foo',
      checks: [{ id: 'a', title: 'A', severity: 'pass', summary: 'ok', details: [] }],
    });
    expect(md).toContain(MARKER);
    expect(md).toContain('All 1 checks passed');
    expect(md).toContain('feat/foo');
    expect(md).toContain('http://x/prs/42');
  });

  it('renders warn-only suite with the warning header and ⚠️ glyph', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abcdef0',
      indexedCommit: 'abcdef0',
      durationMs: 1500,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      checks: [
        {
          id: 'a',
          title: 'A warn',
          severity: 'warn',
          summary: 'maybe',
          details: [{ location: { file: 'f.ts', line: 1 }, message: 'm' }],
        },
      ],
    });
    expect(md).toContain('1 issue found');
    expect(md).toContain('⚠️ A warn');
    expect(md).not.toContain('❌');
  });

  it('truncates details list past 5 entries with a "… and N more" line', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc',
      indexedCommit: 'abc',
      durationMs: 100,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      checks: [
        {
          id: 'a',
          title: 'A',
          severity: 'fail',
          summary: 's',
          details: Array.from({ length: 8 }, (_, i) => ({
            location: { file: `f${i}.ts`, line: i + 1 },
            message: `m${i}`,
          })),
        },
      ],
    });
    // First 5 items rendered, plus a "… and 3 more" overflow note.
    expect(md).toContain('f0.ts');
    expect(md).toContain('f4.ts');
    expect(md).not.toContain('f5.ts');
    expect(md).toContain('and 3 more');
  });

  it('uses singular "issue" for a single failure and plural for many', () => {
    const single = composeMarkdown({
      prNumber: 1,
      commitSha: 'a',
      indexedCommit: 'a',
      durationMs: 1,
      warRoomUrl: 'http://x',
      branch: 'b',
      checks: [{ id: 'a', title: 'A', severity: 'fail', summary: 's', details: [] }],
    });
    expect(single).toContain('1 issue found');

    const many = composeMarkdown({
      prNumber: 1,
      commitSha: 'a',
      indexedCommit: 'a',
      durationMs: 1,
      warRoomUrl: 'http://x',
      branch: 'b',
      checks: [
        { id: 'a', title: 'A', severity: 'fail', summary: 's', details: [] },
        { id: 'b', title: 'B', severity: 'warn', summary: 's', details: [] },
      ],
    });
    expect(many).toContain('2 issues found');
  });

  it('renders failures first', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc',
      indexedCommit: 'abc',
      durationMs: 100,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      checks: [
        { id: 'a', title: 'A', severity: 'pass', summary: 'ok', details: [] },
        {
          id: 'b',
          title: 'B',
          severity: 'fail',
          summary: 'broke',
          details: [{ location: { file: 'f.ts', line: 1 }, message: 'm' }],
        },
      ],
    });
    const failIdx = md.indexOf('B');
    const passIdx = md.indexOf('1 check passed');
    expect(failIdx).toBeLessThan(passIdx);
    expect(md).toContain('1 issue found');
  });

  // ─── Phase 13: per-check "Fix with Claude →" links ──────────────────

  it('does NOT render Fix-with-Claude links when claudeEnabled is false', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc',
      indexedCommit: 'abc',
      durationMs: 100,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      repoFullName: 'octo/repo',
      claudeEnabled: false,
      checks: [
        {
          id: 'incomplete-rename',
          title: 'Incomplete rename',
          severity: 'fail',
          summary: '3 stale callers',
          details: [{ location: { file: 'f.ts', line: 1 }, message: 'caller missed' }],
        },
      ],
    });
    expect(md).not.toContain('Fix with Claude');
    expect(md).not.toContain('new-comment-form');
    // Comment shape is otherwise identical to the v1 layout.
    expect(md).toContain('Incomplete rename');
    expect(md).toContain('1 issue found');
  });

  it('renders Fix-with-Claude links for every known checkId when claudeEnabled is true', () => {
    const knownIds = Object.keys(CLAUDE_COMMANDS);
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc',
      indexedCommit: 'abc',
      durationMs: 100,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      repoFullName: 'octo/repo',
      claudeEnabled: true,
      checks: knownIds.map((id) => ({
        id,
        title: id,
        severity: 'fail' as const,
        summary: 's',
        details: [{ location: { file: 'f.ts', line: 1 }, message: 'm' }],
      })),
    });

    // One "Fix with Claude →" link per known check.
    const linkCount = md.match(/Fix with Claude/g)?.length ?? 0;
    expect(linkCount).toBe(knownIds.length);

    // Each link must be a github.com PR comment-prefill URL with the
    // canonical command URL-encoded into ?body=.
    for (const id of knownIds) {
      const cmd = CLAUDE_COMMANDS[id];
      const encoded = encodeURIComponent(cmd);
      expect(md).toContain(
        `https://github.com/octo/repo/issues/42#new-comment-form?body=${encoded}`,
      );
    }
  });

  it('skips the Fix-with-Claude link for unknown checkIds but keeps it for known ones', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc',
      indexedCommit: 'abc',
      durationMs: 100,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      repoFullName: 'octo/repo',
      claudeEnabled: true,
      checks: [
        {
          id: 'totally-made-up',
          title: 'Mystery check',
          severity: 'fail',
          summary: 's',
          details: [{ location: { file: 'f.ts', line: 1 }, message: 'm' }],
        },
        {
          id: 'incomplete-rename',
          title: 'Incomplete rename',
          severity: 'fail',
          summary: 's',
          details: [{ location: { file: 'g.ts', line: 2 }, message: 'm' }],
        },
      ],
    });

    // Exactly one Fix-with-Claude link — for the known check.
    const linkCount = md.match(/Fix with Claude/g)?.length ?? 0;
    expect(linkCount).toBe(1);

    const encoded = encodeURIComponent(CLAUDE_COMMANDS['incomplete-rename']);
    expect(md).toContain(`https://github.com/octo/repo/issues/42#new-comment-form?body=${encoded}`);

    // Both checks still rendered, just one without the link.
    expect(md).toContain('Mystery check');
    expect(md).toContain('Incomplete rename');
  });

  it('does not render Fix-with-Claude links when repoFullName is missing even if claudeEnabled', () => {
    const md = composeMarkdown({
      prNumber: 42,
      commitSha: 'abc',
      indexedCommit: 'abc',
      durationMs: 100,
      warRoomUrl: 'http://x',
      branch: 'feat/foo',
      claudeEnabled: true, // but no repoFullName
      checks: [
        {
          id: 'incomplete-rename',
          title: 'Incomplete rename',
          severity: 'fail',
          summary: 's',
          details: [{ location: { file: 'f.ts', line: 1 }, message: 'm' }],
        },
      ],
    });
    expect(md).not.toContain('Fix with Claude');
  });
});

describe('findMarkerComment', () => {
  it('finds the comment containing the marker', () => {
    const comments = [
      { id: 1, body: 'hello' },
      { id: 2, body: `prefix\n${MARKER}\nbody` },
      { id: 3, body: null },
    ];
    expect(findMarkerComment(comments)?.id).toBe(2);
  });

  it('returns undefined when no marker is present', () => {
    expect(findMarkerComment([{ id: 1, body: 'no marker here' }])).toBeUndefined();
  });
});
