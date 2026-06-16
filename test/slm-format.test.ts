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
