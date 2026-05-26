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
    expect(out).toContain('GitNexus Review · PR #42');
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
    expect(out).toContain('| `Scripts` | 2 | ⚪ |');
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
    expect(out).toContain('Symbol Changes');
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
    const flows = [];
    for (let i = 0; i < symbolCount; i++) {
      flows.push({ processId: `proc-${i}`, processName: `Flow ${i} ${'f'.repeat(40)}`, hitCount: i });
    }
    const files = [];
    for (let i = 0; i < symbolCount; i++) {
      files.push({ path: `src/very/long/path/to/file-${i}.ts`, status: 'modified' });
    }
    return normalizeBlastResult({
      blastLevel: 'CRITICAL',
      changedSymbols: symbols,
      d1Symbols: symbols,
      d2Symbols: symbols,
      d3Symbols: symbols,
      affectedFlows: flows,
      affectedModules: [],
      changedFiles: files,
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

describe('renderComment — affected flows', () => {
  it('renders the Affected Flows table from the flows fixture, sorted by hits desc', () => {
    const out = renderComment(loadBlast('blast-result-flows.json'), OPTS);
    expect(out).toContain('### Affected Flows');
    expect(out).toContain('| Process | Hits |');
    expect(out).toContain('| Indexing Queue Lifecycle | 7 |');
    expect(out).toContain('| Invite Issuance | 3 |');
    // Sorted by hitCount desc: the 7-hit flow appears before the 3-hit flow.
    expect(out.indexOf('Indexing Queue Lifecycle')).toBeLessThan(out.indexOf('Invite Issuance'));
    // Minimal entry (only processId) falls back to its id with an em-dash hit cell.
    expect(out).toContain('| proc-orphan | — |');
  });

  it('suppresses the Affected Flows section when there are no flows', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).not.toContain('Affected Flows');
  });

  it('escapes pipe and newline characters in flow names', () => {
    const blast = normalizeBlastResult({
      blastLevel: 'LOW',
      changedSymbols: [],
      d1Symbols: [],
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: [{ processName: 'evil|flow\nname', hitCount: 1 }],
      affectedModules: [],
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
    expect(out).toContain('evil\\|flow name');
    expect(out).not.toContain('evil|flow\nname');
  });

  it('caps flow rows at the capped detail level with a "more" trailer', () => {
    const flows = [];
    for (let i = 0; i < 30; i++) flows.push({ processName: `flow-${i}`, hitCount: 30 - i });
    // Force capped detail by padding symbols so full/no-details blow the budget.
    const symbols: SymbolRef[] = [];
    for (let i = 0; i < 4_000; i++) {
      symbols.push({
        id: `s${i}`,
        name: `sym${i}_${'y'.repeat(40)}`,
        type: 'Function',
        filePath: `src/long/path/file-${i}.ts`,
        startLine: i + 1,
        endLine: i + 2,
      });
    }
    const blast = normalizeBlastResult({
      blastLevel: 'HIGH',
      changedSymbols: symbols,
      d1Symbols: symbols,
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: flows,
      affectedModules: [],
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
    expect(out).toContain('### Affected Flows');
    expect(out).toContain('more flow');
  });
});

describe('renderComment — changed files', () => {
  it('renders the Changed Files table from the full fixture', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('Changed Files');
    expect(out).toContain('| File | Status |');
    expect(out).toContain('| `gitnexus-hub/src/routes/admin.ts` | 🟡 modified |');
  });

  it('still renders Changed Files on an otherwise-empty (docs-only) PR', () => {
    const blast = normalizeBlastResult({
      blastLevel: 'LOW',
      changedSymbols: [],
      d1Symbols: [],
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: [],
      affectedModules: [],
      changedFiles: [{ path: 'README.md', status: 'modified' }],
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
    expect(out).toContain('No symbol changes, blast radius, architecture impact');
    expect(out).toContain('Changed Files');
    expect(out).toContain('| `README.md` | 🟡 modified |');
  });

  it('escapes pipe characters in file paths and statuses', () => {
    const blast = normalizeBlastResult({
      blastLevel: 'LOW',
      changedSymbols: [],
      d1Symbols: [],
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: [],
      affectedModules: [{ name: 'm', hits: 1, direct: true }],
      changedFiles: [{ path: 'src/a|b.ts', status: 'mod|ified' }],
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
    expect(out).toContain('src/a\\|b.ts');
    expect(out).toContain('mod\\|ified');
  });
});

describe('renderComment — verdict', () => {
  it('includes a rationale clause for CRITICAL', () => {
    const out = renderComment(loadBlast('blast-result-flows.json'), OPTS);
    expect(out).toContain('Blast level: `CRITICAL`');
    expect(out).toContain('critical surface');
    expect(out).toContain('flows affected');
  });

  it('emits no rationale clause for LOW', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('Blast level: `LOW`');
    expect(out).not.toContain('critical surface');
    expect(out).not.toContain('high reach');
    expect(out).not.toContain('moderate reach');
  });

  it('includes the stale marker when stale', () => {
    const blast = normalizeBlastResult({
      blastLevel: 'MEDIUM',
      changedSymbols: [],
      d1Symbols: [],
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: [],
      affectedModules: [{ name: 'm', hits: 1, direct: true }],
      changedFiles: [],
      fileRiskLevel: null,
      riskFiles: [],
      graphData: { nodes: [], links: [] },
      truncated: false,
      stale: true,
      prTitle: null,
      prAuthor: null,
      prBranch: null,
      prStatus: null,
      computedAt: '2026-05-17T00:00:00.000Z',
    });
    const out = renderComment(blast, OPTS);
    expect(out).toContain('stale — re-run for fresh analysis');
    expect(out).toContain('moderate reach');
  });

  it('survives into the headline-only variant for an oversized PR', () => {
    const symbols: SymbolRef[] = [];
    for (let i = 0; i < 60_000; i++) {
      symbols.push({
        id: `s${i}`,
        name: `sym${i}_${'z'.repeat(80)}`,
        type: 'Function',
        filePath: `src/very/long/path/to/file-${i}.ts`,
        startLine: i + 1,
        endLine: i + 2,
      });
    }
    const blast = normalizeBlastResult({
      blastLevel: 'CRITICAL',
      changedSymbols: symbols,
      d1Symbols: symbols,
      d2Symbols: symbols,
      d3Symbols: symbols,
      affectedFlows: [],
      affectedModules: [],
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
    expect(out.length).toBeLessThanOrEqual(CHAR_BUDGET);
    expect(out).toContain('Blast level: `CRITICAL`');
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
