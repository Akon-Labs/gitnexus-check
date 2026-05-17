import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderComment, COMMENT_MARKER, CHAR_BUDGET } from '../src/render-comment';
import {
  isBlastResult,
  normalizeBlastResult,
  type BlastResult,
  type SymbolRef,
} from '../src/types/blast-result';

function loadBlast(name: string): BlastResult {
  const filePath = path.join(__dirname, 'fixtures', name);
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isBlastResult(parsed)) throw new Error(`fixture ${name} failed isBlastResult`);
  return normalizeBlastResult(parsed);
}

const OPTS = { prNumber: 42, hubUrl: 'https://hub.example.com' };

describe('renderComment — marker + heading', () => {
  it('starts with the v1 marker', () => {
    const out = renderComment(loadBlast('blast-result-empty.json'), OPTS);
    expect(out.startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('includes the PR number heading', () => {
    const out = renderComment(loadBlast('blast-result-empty.json'), OPTS);
    expect(out).toContain('## GitNexus Review: PR #42');
  });

  it('always includes a footer with the hub URL', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('https://hub.example.com');
  });
});

describe('renderComment — empty PR', () => {
  it('emits the "no impact" sentence', () => {
    const out = renderComment(loadBlast('blast-result-empty.json'), OPTS);
    expect(out).toContain('No symbol changes, blast radius, architecture impact');
    expect(out).not.toContain('### Architecture Impact');
    expect(out).not.toContain('### Blast Radius');
  });
});

describe('renderComment — full fixture (real Hub response)', () => {
  it('renders Architecture Impact when modules present', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('### Architecture Impact');
    expect(out).toContain('| `Scripts` | 2 | no |');
  });

  it('renders Blast Radius counts including zeros', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('### Blast Radius');
    expect(out).toContain('| d1 (direct)     | 1 |');
    expect(out).toContain('| d2 (indirect)   | 0 |');
    expect(out).toContain('| d3 (transitive) | 0 |');
  });

  it('renders Symbol Changes table', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('### Symbol Changes');
    expect(out).toContain('`generateCode`');
    expect(out).toContain('gitnexus-hub/scripts/create-invite.ts:14');
  });

  it('omits API Surface Delta when no Route/Export symbols', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).not.toContain('### API Surface Delta');
  });

  it('emits the Direct dependents details block in full detail mode', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('<details><summary>Direct dependents (d1)</summary>');
    expect(out).toContain('`create-invite.ts`');
  });
});

describe('renderComment — truncated fixture (with Route + Export)', () => {
  it('renders API Surface Delta section when Route present', () => {
    const out = renderComment(loadBlast('blast-result-truncated.json'), OPTS);
    expect(out).toContain('### API Surface Delta');
    expect(out).toContain('POST /invoices/:id/void');
  });

  it('appends a truncation footer when blast.truncated is true', () => {
    const out = renderComment(loadBlast('blast-result-truncated.json'), OPTS);
    expect(out).toContain('Comment truncated');
  });
});

describe('renderComment — char budget', () => {
  function bigBlast(symbolCount: number): BlastResult {
    const symbols: SymbolRef[] = [];
    for (let i = 0; i < symbolCount; i++) {
      symbols.push({
        id: `Function:src/file-${i}.ts:fn${i}`,
        name: `fn${i}_${'x'.repeat(50)}`,
        type: 'Function',
        filePath: `src/very/long/path/to/file-${i}.ts`,
        startLine: i + 1,
        endLine: i + 10,
      });
    }
    return normalizeBlastResult({
      blastLevel: 'CRITICAL',
      changedSymbols: symbols,
      d1Symbols: symbols,
      d2Symbols: symbols,
      d3Symbols: symbols,
      affectedFlows: [],
      affectedModules: [],
      changedFiles: [],
      fileRiskLevel: 'HIGH',
      riskFiles: [],
      graphData: { nodes: [], links: [] },
      truncated: false,
      stale: false,
      prTitle: 't',
      prAuthor: 'a',
      prBranch: 'b',
      prStatus: 'open',
      computedAt: '2026-05-17T00:00:00.000Z',
    });
  }

  it('stays within CHAR_BUDGET even for 5,000-symbol PR', () => {
    const out = renderComment(bigBlast(5_000), OPTS);
    expect(out.length).toBeLessThanOrEqual(CHAR_BUDGET);
  });

  it('emits the truncation footer when shrinking down to fit', () => {
    const out = renderComment(bigBlast(5_000), OPTS);
    expect(out).toContain('Comment truncated');
  });

  it('full fixture fits comfortably under budget', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out.length).toBeLessThan(CHAR_BUDGET / 10);
  });
});

describe('renderComment — escaping', () => {
  it('escapes pipe characters in module / symbol names', () => {
    const blast = normalizeBlastResult({
      blastLevel: 'LOW',
      changedSymbols: [
        {
          id: 'x',
          name: 'evil|name',
          type: 'Function',
          filePath: 'src/a|b.ts',
          startLine: 1,
          endLine: 2,
        },
      ],
      d1Symbols: [],
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: [],
      affectedModules: [{ name: 'a|b', hits: 1, direct: true }],
      changedFiles: [],
      fileRiskLevel: null,
      riskFiles: [],
      graphData: { nodes: [], links: [] },
      truncated: false,
      stale: false,
      prTitle: null,
      prAuthor: null,
      prBranch: null,
      prStatus: null,
      computedAt: '2026-05-17T00:00:00.000Z',
    });
    const out = renderComment(blast, OPTS);
    expect(out).toContain('a\\|b');
    expect(out).toContain('evil\\|name');
    expect(out).toContain('src/a\\|b.ts');
  });
});
