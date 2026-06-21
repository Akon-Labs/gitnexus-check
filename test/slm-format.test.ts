/**
 * Unit tests for composeWithDigest — splicing the Hub-provided `## Summary`
 * digest into the deterministic comment and collapsing the heavy detail.
 */
import { describe, it, expect } from 'vitest';
import { composeWithDigest } from '../src/slm-format';

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
});

const SHA40 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const DELTA = { headSha: SHA40, summary: '🔁 Fixed the null guard in `parse()`.' };

describe('composeWithDigest — since-last-commit delta', () => {
  it('(a) renders the delta block ABOVE ## Summary, marker still first line', () => {
    const out = composeWithDigest(rawComment(), DIGEST, DELTA);
    expect(out.split('\n')[0]).toBe(MARKER);
    const deltaIdx = out.indexOf('## 🔁 Since last commit');
    const summaryIdx = out.indexOf('## Summary');
    expect(deltaIdx).toBeGreaterThan(0);
    expect(summaryIdx).toBeGreaterThan(deltaIdx);
    // shortSha truncation: 40-char sha → 7-char in the header.
    expect(out).toContain('## 🔁 Since last commit (`a1b2c3d`)');
    expect(out).toContain('🔁 Fixed the null guard in `parse()`.');
  });

  it('(b) delta only (empty digest) → delta rendered, NO ## Summary header', () => {
    const out = composeWithDigest(rawComment(), '', DELTA);
    expect(out.split('\n')[0]).toBe(MARKER);
    expect(out).toContain('## 🔁 Since last commit (`a1b2c3d`)');
    expect(out).not.toContain('## Summary');
    // Detail still collapsed into the one expander.
    expect(out).toContain('📋 Full report');
  });

  it('(c) empty-blast (no divider) + no delta → BYTE-IDENTICAL to today, no 📋 Full report', () => {
    const empty = `${MARKER}\n\n### GitNexus Review · PR #7\n\nNo impact detected.`;
    const withField = composeWithDigest(empty, DIGEST, null);
    const today = composeWithDigest(empty, DIGEST);
    expect(withField).toBe(today);
    expect(withField).not.toContain('📋 Full report');
    expect(withField).toContain('## Summary');
  });

  it('(d) empty-blast + delta → delta shown, no spurious <details> expander', () => {
    const empty = `${MARKER}\n\n### GitNexus Review · PR #7\n\nNo impact detected.`;
    const out = composeWithDigest(empty, DIGEST, DELTA);
    expect(out.split('\n')[0]).toBe(MARKER);
    expect(out).toContain('## 🔁 Since last commit (`a1b2c3d`)');
    expect(out).not.toContain('<details>');
    expect(out).not.toContain('📋 Full report');
    // Delta sits above the digest.
    expect(out.indexOf('## 🔁 Since last commit')).toBeLessThan(out.indexOf('## Summary'));
  });

  it('(e) digest, no delta (undefined 3rd arg) → byte-identical to two-arg call', () => {
    expect(composeWithDigest(rawComment(), DIGEST, undefined)).toBe(
      composeWithDigest(rawComment(), DIGEST),
    );
  });

  it('(f) shortSha truncates a 40-char sha to 7 and passes a short string through', () => {
    const long = composeWithDigest(rawComment(), '', { headSha: SHA40, summary: 's' });
    expect(long).toContain('(`a1b2c3d`)');
    const short = composeWithDigest(rawComment(), '', { headSha: 'abc12', summary: 's' });
    expect(short).toContain('(`abc12`)');
  });
});
