/**
 * Unit tests for composeWithDigest — splicing the Hub-provided `## Summary`
 * digest into the deterministic comment and collapsing the heavy detail.
 */
import { describe, it, expect } from 'vitest';
import {
  composeWithDigest,
  renderSinceCommitComment,
  sinceCommitMarker,
} from '../src/slm-format';

const MARKER = '<!-- gitnexus-review-v1 -->';

/** A realistic deterministic comment: marker → header → verdict → metrics → --- → detail. */
function rawComment(): string {
  return [
    MARKER,
    '',
    '### GitNexus Review · PR #7',
    '',
    '> 🔴 Blast level: `CRITICAL`',
    '',
    '| Blast Level | Dependents |',
    '|:--:|:--:|',
    '| 🔴 `CRITICAL` | 0 |',
    '',
    '---',
    '',
    '## What changed',
    '',
    '<details>',
    '<summary><b>Symbol Changes (162)</b></summary>',
    '',
    '| Kind | Symbol |',
    '|---|---|',
    '',
    '</details>',
    '',
    '<details>',
    '<summary><b>Changed Files (117)</b></summary>',
    '',
    '</details>',
    '',
    '## What it affects',
    '',
    '<details>',
    '<summary><b>Affected Flows (58)</b></summary>',
    '',
    '</details>',
  ].join('\n');
}

const DIGEST = '## Summary\n\n🔴 **CRITICAL** — 5 modules, 58 flows.';

describe('composeWithDigest', () => {
  it('keeps the marker as the first line', () => {
    const out = composeWithDigest(rawComment(), DIGEST);
    expect(out.startsWith(MARKER)).toBe(true);
  });

  it('inserts the digest after the metrics strip and before the detail', () => {
    const out = composeWithDigest(rawComment(), DIGEST);
    const summaryIdx = out.indexOf('## Summary');
    const metricsIdx = out.indexOf('| Blast Level');
    const detailsIdx = out.indexOf('<details>');
    expect(metricsIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(metricsIdx);
    expect(detailsIdx).toBeGreaterThan(summaryIdx);
  });

  it('wraps the full detail in one collapsed expander with exact counts', () => {
    const out = composeWithDigest(rawComment(), DIGEST);
    expect(out).toContain('<summary><b>📋 Full report — 162 symbols · 117 files · 58 flows</b></summary>');
    // The detail sections live INSIDE the expander (after the summary line).
    const expanderIdx = out.indexOf('📋 Full report');
    expect(out.indexOf('## What changed')).toBeGreaterThan(expanderIdx);
    // Balanced details tags (3 inner + 1 outer wrapper).
    expect((out.match(/<details>/g) || []).length).toBe(4);
    expect((out.match(/<\/details>/g) || []).length).toBe(4);
  });

  it('preserves the digest text verbatim', () => {
    const out = composeWithDigest(rawComment(), DIGEST);
    expect(out).toContain('🔴 **CRITICAL** — 5 modules, 58 flows.');
  });

  it('falls back to appending the digest when there is no divider (empty-blast)', () => {
    const empty = `${MARKER}\n\n### GitNexus Review · PR #7\n\nNo impact detected.`;
    const out = composeWithDigest(empty, DIGEST);
    expect(out.startsWith(MARKER)).toBe(true);
    expect(out).toContain('## Summary');
    expect(out).not.toContain('📋 Full report'); // nothing heavy to collapse
  });

  it('omits absent counts from the expander label', () => {
    const onlySymbols = [MARKER, '', '| m |', '', '---', '', '<details><summary><b>Symbol Changes (3)</b></summary></details>'].join('\n');
    const out = composeWithDigest(onlySymbols, DIGEST);
    // Exact label: only the symbols segment, no files/flows segments appended.
    expect(out).toContain('<summary><b>📋 Full report — 3 symbols</b></summary>');
  });

  // The always-collapse rule: a missing/failed digest must never dump the
  // detail tables above the fold — head → divider → ONE collapsed expander.
  it('collapses the detail into the Full report expander even with an empty digest', () => {
    const out = composeWithDigest(rawComment(), '');
    expect(out.startsWith(MARKER)).toBe(true);
    expect(out).not.toContain('## Summary');
    expect(out).toContain('<summary><b>📋 Full report — 162 symbols · 117 files · 58 flows</b></summary>');
    // Verdict + metrics strip stay above the divider; detail sits inside the expander.
    expect(out.indexOf('| Blast Level')).toBeLessThan(out.indexOf('\n---\n'));
    expect(out.indexOf('## What changed')).toBeGreaterThan(out.indexOf('📋 Full report'));
  });

  it('returns an empty-blast comment unchanged when the digest is empty too', () => {
    const empty = `${MARKER}\n\n### GitNexus Review · PR #7\n\nNo impact detected.`;
    expect(composeWithDigest(empty, '')).toBe(empty);
  });
});

describe('composeWithDigest — main comment carries NO since-last-commit delta', () => {
  it('the digest-spliced main comment never contains the delta block', () => {
    const out = composeWithDigest(rawComment(), DIGEST);
    expect(out).not.toContain("What's new in this push");
    expect(out).not.toContain('gitnexus-since-commit');
  });

  it('the empty-blast main comment never contains the delta block', () => {
    const empty = `${MARKER}\n\n### GitNexus Review · PR #7\n\nNo impact detected.`;
    const out = composeWithDigest(empty, DIGEST);
    expect(out).not.toContain("What's new in this push");
  });
});

const SHA40 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const DELTA = { headSha: SHA40, summary: '🔁 Fixed the null guard in `parse()`.' };

describe('renderSinceCommitComment — standalone per-commit comment', () => {
  it('begins with the per-SHA marker line', () => {
    const out = renderSinceCommitComment(DELTA);
    expect(out.split('\n')[0]).toBe(`<!-- gitnexus-since-commit:${SHA40} -->`);
    expect(out.split('\n')[0]).toBe(sinceCommitMarker(SHA40));
  });

  it('contains the delta block (short sha header), the verbatim summary, and the pointer footer', () => {
    const out = renderSinceCommitComment(DELTA);
    // shortSha truncation: 40-char sha → 7-char in the visible header.
    expect(out).toContain("### 🔄 What's new in this push (`a1b2c3d`)");
    expect(out).toContain('🔁 Fixed the null guard in `parse()`.');
    expect(out).toContain('_The main GitNexus review comment has the full, updated report._');
  });

  it('the marker (full sha) appears before the visible short-sha header', () => {
    const out = renderSinceCommitComment(DELTA);
    expect(out.indexOf(sinceCommitMarker(SHA40))).toBeLessThan(
      out.indexOf("### 🔄 What's new in this push"),
    );
  });

  it('shortSha truncates a 40-char sha to 7 and passes a short string through', () => {
    expect(renderSinceCommitComment({ headSha: SHA40, summary: 's' })).toContain('this push (`a1b2c3d`)');
    expect(renderSinceCommitComment({ headSha: 'abc12', summary: 's' })).toContain('this push (`abc12`)');
  });
});

describe('sinceCommitMarker — per-SHA idempotency key', () => {
  it('is distinct per head sha and stable for the same sha', () => {
    const a = sinceCommitMarker('aaaaaaa');
    const b = sinceCommitMarker('bbbbbbb');
    expect(a).toBe('<!-- gitnexus-since-commit:aaaaaaa -->');
    expect(a).not.toBe(b);
    expect(sinceCommitMarker('aaaaaaa')).toBe(a);
  });
});
