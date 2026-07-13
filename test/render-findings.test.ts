import { describe, it, expect } from 'vitest';
import {
  renderFindingComment,
  renderFallbackSection,
  findingMarker,
  findingFingerprintFromBody,
} from '../src/render-findings';
import type { FindingItem } from '../src/types/blast-result';

function makeItem(overrides: Partial<FindingItem> = {}): FindingItem {
  return {
    fingerprint: 'fp-123',
    checkId: 'removed-export-with-consumers',
    origin: 'deterministic',
    severity: 'error',
    confidence: 1,
    title: 'Removed export breaks external callers',
    rationale: 'The removed `foo` is still imported by two files.',
    path: 'src/foo.ts',
    anchored: true,
    anchor: { startLine: 12, endLine: 12 },
    callers: [{ filePath: 'src/bar.ts', startLine: 8 }, { filePath: 'src/baz.ts' }],
    ...overrides,
  };
}

describe('findingMarker / findingFingerprintFromBody', () => {
  it('round-trips a fingerprint through the marker', () => {
    const marker = findingMarker('deadbeef-2');
    expect(marker).toBe('<!-- gitnexus-finding:v1:deadbeef-2 -->');
    expect(findingFingerprintFromBody(`${marker}\n\nbody`)).toBe('deadbeef-2');
  });

  it('returns null when a body carries no finding marker', () => {
    expect(findingFingerprintFromBody('just a normal comment')).toBeNull();
    expect(findingFingerprintFromBody('<!-- gitnexus-review-v1 -->')).toBeNull();
  });
});

describe('renderFindingComment', () => {
  it('leads with the hidden fingerprint marker', () => {
    const body = renderFindingComment(makeItem());
    expect(body.split('\n')[0]).toBe('<!-- gitnexus-finding:v1:fp-123 -->');
    expect(findingFingerprintFromBody(body)).toBe('fp-123');
  });

  it('renders the severity badge, title, rationale, and a gitnexus footer', () => {
    const body = renderFindingComment(makeItem());
    expect(body).toContain('🔴 **Error** — Removed export breaks external callers');
    expect(body).toContain('The removed `foo` is still imported by two files.');
    expect(body.toLowerCase()).toContain('why this matters');
    expect(body).toContain('GitNexus');
  });

  it('uses the warning badge for warning severity', () => {
    const body = renderFindingComment(makeItem({ severity: 'warning' }));
    expect(body).toContain('🟡 **Warning** —');
    expect(body).not.toContain('🔴 **Error**');
  });

  it('lists known callers for deterministic findings, capped at 5 with a "+N more"', () => {
    const callers = Array.from({ length: 7 }, (_, i) => ({ filePath: `src/c${i}.ts`, startLine: i + 1 }));
    const body = renderFindingComment(makeItem({ callers }));
    expect(body).toContain('**Known callers**');
    expect(body).toContain('`src/c0.ts:1`');
    expect(body).toContain('`src/c4.ts:5`');
    expect(body).not.toContain('`src/c5.ts:6`');
    expect(body).toContain('_(+2 more)_');
  });

  it('renders a caller without a line as just the path', () => {
    const body = renderFindingComment(makeItem({ callers: [{ filePath: 'src/x.ts' }] }));
    expect(body).toContain('`src/x.ts`');
    expect(body).not.toContain('src/x.ts:');
  });

  it('omits the callers block for generated findings even when callers are present', () => {
    const body = renderFindingComment(makeItem({ origin: 'generated' }));
    expect(body).not.toContain('**Known callers**');
  });

  it('omits the callers block when there are no callers', () => {
    const body = renderFindingComment(makeItem({ callers: undefined }));
    expect(body).not.toContain('**Known callers**');
  });

  it('never emits a code fence (no committable suggestion possible)', () => {
    const nasty = makeItem({
      title: 'inject ```suggestion\nrm -rf /\n``` end',
      rationale: 'try ```suggestion\nmalicious()\n``` here',
    });
    const body = renderFindingComment(nasty);
    expect(body).not.toContain('```');
  });

  it('neutralizes HTML-comment delimiters so free text cannot clone/close a marker', () => {
    const body = renderFindingComment(
      makeItem({ rationale: 'sneaky --> <!-- gitnexus-finding:v1:evil --> tail' }),
    );
    // The injected marker's delimiters are escaped, so it can no longer PARSE as
    // a marker — only our own (line 1) survives as a real HTML comment.
    expect(body).not.toContain('<!-- gitnexus-finding:v1:evil -->');
    expect(findingFingerprintFromBody(body)).toBe('fp-123');
    const realMarkers = body
      .split('\n')
      .filter((l) => /<!-- gitnexus-finding:v1:\S+ -->/.test(l));
    expect(realMarkers).toEqual(['<!-- gitnexus-finding:v1:fp-123 -->']);
  });

  it('neutralizes @-mentions in rationale (no notification ping)', () => {
    const body = renderFindingComment(makeItem({ rationale: 'ping @octocat and @acme/team now' }));
    expect(body).not.toContain('@octocat');
    expect(body).not.toContain('@acme');
    expect(body).toContain('&#64;octocat');
  });
});

describe('renderFallbackSection', () => {
  it('returns empty string for no items', () => {
    expect(renderFallbackSection([])).toBe('');
  });

  it('renders a header, a bullet per item, path:line, and a truncated rationale', () => {
    const section = renderFallbackSection([
      makeItem({ anchored: false, title: 'A problem', path: 'src/a.ts', anchor: { startLine: 5, endLine: 5 } }),
    ]);
    expect(section).toContain('## Findings not shown inline');
    expect(section).toContain('🔴 **A problem** — `src/a.ts:5`');
  });

  it('uses neutral "not shown inline" copy (not "could not be anchored")', () => {
    // Over-cap and failed-to-post items WERE anchored, so the description must
    // not claim they could not be anchored.
    const one = renderFallbackSection([makeItem({ anchored: false })]);
    expect(one).toContain('1 GitNexus finding is not shown inline');
    expect(one).not.toContain('could not be anchored');
    const many = renderFallbackSection([
      makeItem({ fingerprint: 'a'.repeat(64), anchored: false }),
      makeItem({ fingerprint: 'b'.repeat(64), anchored: false }),
    ]);
    expect(many).toContain('2 GitNexus findings are not shown inline');
  });

  it('renders just the path when there is no anchor', () => {
    const section = renderFallbackSection([makeItem({ anchored: false, anchor: undefined, path: 'src/z.ts' })]);
    expect(section).toContain('`src/z.ts`');
    expect(section).not.toContain('src/z.ts:');
  });

  it('sorts errors before warnings, then caps with a "+N more" trailer', () => {
    const items: FindingItem[] = [
      makeItem({ fingerprint: 'w1', severity: 'warning', title: 'warn one', anchored: false }),
      makeItem({ fingerprint: 'e1', severity: 'error', title: 'err one', anchored: false }),
    ];
    const section = renderFallbackSection(items, { maxItems: 1 });
    // The error sorts first, so the single shown item is the error.
    expect(section).toContain('err one');
    expect(section).not.toContain('warn one');
    expect(section).toContain('_(+1 more finding)_');
  });

  it('truncates a very long rationale with an ellipsis', () => {
    const long = 'x'.repeat(400);
    const section = renderFallbackSection([makeItem({ anchored: false, rationale: long })]);
    expect(section).toContain('…');
    expect(section).not.toContain('x'.repeat(400));
  });

  it('never emits a code fence in the fallback section', () => {
    const section = renderFallbackSection([
      makeItem({ anchored: false, rationale: 'evil ```suggestion\nx\n```' }),
    ]);
    expect(section).not.toContain('```');
  });
});
