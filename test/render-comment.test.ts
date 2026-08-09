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

  it('does not render the metadata footer line', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).not.toContain('GitNexus Hub');
    expect(out).not.toContain('computed `');
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

  it('groups sections into intent buckets, "What changed" before "What it affects"', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('## What changed');
    expect(out).toContain('## What it affects');
    expect(out.indexOf('## What changed')).toBeLessThan(out.indexOf('## What it affects'));
  });
});

describe('renderComment — truncated fixture (with Route + Export)', () => {
  it('renders API Surface Delta section when Route present', () => {
    const out = renderComment(loadBlast('blast-result-truncated.json'), OPTS);
    expect(out).toContain('### API Surface Delta');
    expect(out).toContain('POST /invoices/:id/void');
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

  it('never emits a truncation footer', () => {
    const out = renderComment(bigBlast(5_000), OPTS);
    expect(out).not.toContain('Comment truncated');
  });

  it('full fixture fits comfortably under budget', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out.length).toBeLessThan(CHAR_BUDGET / 10);
  });
});

describe('renderComment — affected flows', () => {
  it('renders the Affected Flows table from the flows fixture, sorted by hits desc', () => {
    const out = renderComment(loadBlast('blast-result-flows.json'), OPTS);
    expect(out).toContain('Affected Flows');
    expect(out).toContain('| Process | Hits |');
    expect(out).toContain('| Indexing Queue Lifecycle | 7 |');
    expect(out).toContain('| Invite Issuance | 3 |');
    // Sorted by hitCount desc: the 7-hit flow appears before the 3-hit flow.
    expect(out.indexOf('Indexing Queue Lifecycle')).toBeLessThan(out.indexOf('Invite Issuance'));
    // Minimal entry (only processId) falls back to its id with an em-dash hit cell.
    expect(out).toContain('| proc-orphan | n/a |');
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
    expect(out).toContain('Affected Flows');
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
    expect(out).toContain('**CRITICAL blast radius**');
    expect(out).toContain('critical surface, so review the dependents carefully before merging');
    expect(out).toContain('execution flow');
  });

  it('emits no rationale clause for LOW', () => {
    const out = renderComment(loadBlast('blast-result-full.json'), OPTS);
    expect(out).toContain('**LOW blast radius**');
    expect(out).not.toContain('critical surface');
    expect(out).not.toContain('dependent list before merging');
    expect(out).not.toContain('spot-check of the dependents');
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
    expect(out).toContain('stale, re-run for fresh analysis');
    expect(out).toContain('spot-check of the dependents');
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
    expect(out).toContain('**CRITICAL blast radius**');
  });
});

describe('renderComment — recommendations', () => {
  function elevatedBlast(level: BlastResult['blastLevel']): BlastResult {
    const d1: SymbolRef[] = [];
    for (let i = 0; i < 20; i++) {
      d1.push({ id: `d${i}`, name: `dep${i}`, type: 'Function', filePath: `src/x${i}.ts`, startLine: 1, endLine: 2 });
    }
    const changed: SymbolRef[] = [];
    for (let i = 0; i < 9; i++) {
      changed.push({ id: `c${i}`, name: `fn${i}`, type: 'Function', filePath: 'src/hot.ts', startLine: i, endLine: i + 1 });
    }
    const flows = [];
    for (let i = 0; i < 6; i++) flows.push({ processName: `Flow ${i}`, hitCount: i });
    return normalizeBlastResult({
      blastLevel: level,
      changedSymbols: changed,
      d1Symbols: d1,
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: flows,
      affectedModules: [
        { name: 'A', hits: 5, direct: true },
        { name: 'B', hits: 3, direct: true },
        { name: 'C', hits: 1, direct: false },
      ],
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
  }

  it('emits actionable, data-derived tips for a CRITICAL PR', () => {
    const out = renderComment(elevatedBlast('CRITICAL'), OPTS);
    expect(out).toContain('## How to reduce the blast radius');
    expect(out).toContain('20 direct dependents');
    expect(out).toContain('module'); // spans-modules tip
    expect(out).toContain('execution flows');
    expect(out).toContain('`src/hot.ts` concentrates 9 changed symbols');
  });

  it('shows recommendations for HIGH and MEDIUM as well', () => {
    expect(renderComment(elevatedBlast('HIGH'), OPTS)).toContain(
      '## How to reduce the blast radius',
    );
    expect(renderComment(elevatedBlast('MEDIUM'), OPTS)).toContain(
      '## How to reduce the blast radius',
    );
  });

  it('omits recommendations for LOW', () => {
    const low = renderComment(elevatedBlast('LOW'), OPTS);
    expect(low).not.toContain('How to reduce the blast radius');
  });

  it('caps the tips so it does not become a dump', () => {
    const out = renderComment(elevatedBlast('CRITICAL'), OPTS);
    const tipCount = (out.match(/^- \*\*/gm) ?? []).length;
    expect(tipCount).toBeLessThanOrEqual(4);
  });
});

describe('renderComment — crossRepo backward-compat', () => {
  it('absent or empty crossRepo renders byte-identical to a no-crossRepo result', () => {
    // The backward-compat tripwire: a Hub that omits crossRepo (or sends the
    // zero-state envelope) must produce exactly the v1 comment. base has no
    // crossRepo field; withEmpty carries the zero-state. Both normalize to the
    // same EMPTY_CROSS_REPO and must render identically.
    const base = loadBlast('blast-result-full.json');
    const withEmpty = normalizeBlastResult({
      ...base,
      crossRepo: { schemaVersion: '1', findings: [], groups: [], truncated: false, error: null },
    });
    expect(renderComment(withEmpty, OPTS)).toBe(renderComment(base, OPTS));
  });
});

describe('renderComment — crossRepo rendering', () => {
  function withFindings(findings: unknown[], groups: unknown[] = [], error: string | null = null) {
    const base = loadBlast('blast-result-full.json');
    return normalizeBlastResult({
      ...base,
      crossRepo: { schemaVersion: '1', findings, groups, truncated: false, error },
    });
  }

  it('renders the Cross-Repo Impact bucket from the captured fixture', () => {
    const out = renderComment(loadBlast('blast-result-cross-repo.json'), OPTS);
    expect(out).toContain('## Cross-Repo Impact');
    // Each consumer repo is collapsed behind a <details> summary with its count.
    expect(out).toContain('<summary><b>acme/widget-web · 1 interface</b></summary>');
    // symbol findings land in the "Imported symbols" channel; raw float never shown.
    expect(out).toContain('**Imported symbols** (1):');
    expect(out).toContain('`fetchBlast` (used in `src/api/blast.ts`)');
    expect(out).not.toContain('0.92');
  });

  it('opens with a plain-English explanation of what the section means', () => {
    const out = renderComment(loadBlast('blast-result-cross-repo.json'), OPTS);
    expect(out).toContain('depend on code this PR changes');
  });

  it('places the bucket between "What it affects" and "What to check"', () => {
    const blast = withFindings(
      [
        {
          kind: 'symbol',
          consumerRepo: 'acme/web',
          consumerSymbol: { name: 'f', filePath: 'src/f.ts' },
          providerSymbol: null,
          via: 'imports f',
          edgeType: 'IMPORTS',
          detectionTier: 'static',
          confidence: 0.95,
        },
      ],
      [],
    );
    const out = renderComment(blast, OPTS);
    const affects = out.indexOf('## What it affects');
    const cross = out.indexOf('## Cross-Repo Impact');
    expect(affects).toBeGreaterThanOrEqual(0);
    expect(cross).toBeGreaterThan(affects);
  });

  it('adds the verdict clause naming the affected repos', () => {
    const blast = withFindings([
      sym('acme/web', 0.95),
      sym('acme/mobile', 0.95),
    ]);
    const out = renderComment(blast, OPTS);
    expect(out).toContain('It also reaches 2 other repos (acme/web, acme/mobile).');
  });

  it('groups HTTP routes and messaging topics into compact channels', () => {
    const blast = withFindings([
      contract('acme/api', 'http:GET /api/tasks'),
      contract('acme/api', 'http:POST /api/tasks'),
      contract('acme/api', 'messaging:task.created'),
    ]);
    const out = renderComment(blast, OPTS);
    // channel labels + counts, with the http:/messaging: prefix stripped, inline.
    expect(out).toContain('**HTTP routes** (2): `GET /api/tasks`, `POST /api/tasks`');
    expect(out).toContain('**Messaging topics** (1): `task.created`');
    // no per-line "verify before merge" noise anymore.
    expect(out).not.toContain('verify before merge');
  });

  it('renders flow findings under a named header with step context', () => {
    const blast = withFindings([
      {
        kind: 'flow',
        consumerRepo: '',
        via: 'checkout pipeline',
        flow: { label: 'checkout pipeline', step: 2, stepCount: 4, repoIds: ['a', 'b', 'c'] },
        edgeType: 'STEP_IN_CROSS_PROCESS',
        detectionTier: 'process',
        confidence: 1,
      },
    ]);
    const out = renderComment(blast, OPTS);
    expect(out).toContain('<summary><b>Shared cross-repo flows · 1 interface</b></summary>');
    expect(out).toContain('**Shared flows** (1):');
    expect(out).toContain('`checkout pipeline` (step 2 of 4)');
  });

  it('appends the (LLM-matched) note on an llm_adjudicated flow finding', () => {
    const blast = withFindings([
      {
        kind: 'flow',
        consumerRepo: '',
        via: 'checkout pipeline',
        flow: { label: 'checkout pipeline', step: 2, stepCount: 4, repoIds: ['a', 'b'] },
        edgeType: 'STEP_IN_CROSS_PROCESS',
        detectionTier: 'llm_adjudicated',
        confidence: 0.7,
      },
    ]);
    const out = renderComment(blast, OPTS);
    // A flow renders the LLM provenance note like symbol/contract findings do.
    expect(out).toContain('`checkout pipeline` (step 2 of 4) _(LLM-matched)_');
  });

  it('omits the (LLM-matched) note on a deterministically-detected flow finding', () => {
    const blast = withFindings([
      {
        kind: 'flow',
        consumerRepo: '',
        via: 'checkout pipeline',
        flow: { label: 'checkout pipeline', step: 2, stepCount: 4, repoIds: ['a', 'b'] },
        edgeType: 'STEP_IN_CROSS_PROCESS',
        detectionTier: 'process',
        confidence: 1,
      },
    ]);
    const out = renderComment(blast, OPTS);
    expect(out).not.toContain('_(LLM-matched)_');
  });

  it('renders a generic degraded caveat on error WITHOUT echoing the raw error string', () => {
    const blast = withFindings([], [], 'bridge file missing for Secret Internal Group, re-analyze');
    const out = renderComment(blast, OPTS);
    expect(out).toContain('## Cross-Repo Impact');
    expect(out).toContain('_Cross-repo analysis was incomplete, so some dependents may be missing._');
    expect(out).toContain('_(cross-repo analysis unavailable)_'); // headline caveat
    expect(out).not.toContain('Secret Internal Group'); // privacy: no group name leak
  });

  it('escapes pipe characters in consumerRepo and via', () => {
    const blast = withFindings([
      {
        kind: 'contract',
        consumerRepo: 'acme/ev|il',
        via: 'http:GET /a|b',
        edgeType: 'CALLS',
        detectionTier: 'tier3_http',
        confidence: 0.7,
      },
    ]);
    const out = renderComment(blast, OPTS);
    expect(out).toContain('acme/ev\\|il');
    expect(out).toContain('/a\\|b');
  });

  it('survives the capped truncation level and applies the per-repo cap (3)', () => {
    // A huge changed-symbol list forces the renderer down to `capped` (the
    // symbol list caps at 50 and fits the budget). The cross-repo bucket must
    // survive capping, but each consumer repo is limited to 3 findings.
    const huge: SymbolRef[] = Array.from({ length: 20000 }, (_, i) => ({
      id: `s${i}`,
      name: `symbol_${i}_${'x'.repeat(40)}`,
      type: 'Function',
      filePath: `src/path/to/file_${i}.ts`,
      startLine: 1,
      endLine: 2,
    }));
    const base = loadBlast('blast-result-full.json');
    const blast = normalizeBlastResult({
      ...base,
      changedSymbols: huge,
      crossRepo: {
        schemaVersion: '1',
        findings: [
          sym('acme/web', 0.95),
          sym('acme/web', 0.95),
          sym('acme/web', 0.95),
          sym('acme/web', 0.95),
          sym('acme/web', 0.95),
        ],
        groups: [],
        truncated: false,
        error: null,
      },
    });
    const out = renderComment(blast, OPTS);
    expect(out.length).toBeLessThanOrEqual(CHAR_BUDGET);
    expect(out).toContain('## Cross-Repo Impact');
    expect(out).toContain('<summary><b>acme/web · 5 interfaces</b></summary>'); // true count
    expect(out).toContain('_…and 2 more in this repo._'); // only 3 rendered at capped
    expect(out).toContain('It also reaches 1 other repo (acme/web).'); // verdict clause present
  });

  it('degrades an unknown schemaVersion to an error envelope', () => {
    const base = loadBlast('blast-result-full.json');
    const blast = normalizeBlastResult({
      ...base,
      crossRepo: { schemaVersion: '2', findings: [sym('acme/web', 0.95)], groups: [], truncated: false, error: null },
    });
    // normalize drops findings and sets error → bucket shows the degraded notice.
    expect(blast.crossRepo?.findings).toHaveLength(0);
    expect(blast.crossRepo?.error).toContain('unsupported crossRepo schema version: 2');
    const out = renderComment(blast, OPTS);
    expect(out).toContain('_Cross-repo analysis was incomplete, so some dependents may be missing._');
  });
});

/** Build a minimal symbol cross-repo finding for a given consumer repo + confidence. */
function sym(consumerRepo: string, confidence: number) {
  return {
    kind: 'symbol' as const,
    consumerRepo,
    consumerSymbol: { name: 'fetchBlast', filePath: 'src/api/blast.ts' },
    providerSymbol: { name: 'compute', filePath: 'src/compute.ts', symbolLabel: 'Function' },
    via: 'imports fetchBlast',
    edgeType: 'IMPORTS',
    detectionTier: 'static',
    confidence,
  };
}

/** Build a minimal contract cross-repo finding for a given consumer repo + via. */
function contract(consumerRepo: string, via: string) {
  return {
    kind: 'contract' as const,
    consumerRepo,
    via,
    edgeType: 'CALLS',
    detectionTier: via.startsWith('messaging:') ? 'tier2_async' : 'tier3_http',
    confidence: via.startsWith('messaging:') ? 0.8 : 0.7,
  };
}

describe('renderComment — HTTP symbol tier + call sites', () => {
  /** Overlay a raw crossRepo envelope onto the full fixture and normalize. */
  function withCross(cross: unknown): BlastResult {
    const base = loadBlast('blast-result-full.json');
    return normalizeBlastResult({ ...base, crossRepo: cross } as unknown as BlastResult);
  }

  it('routes sym→sym HTTP edges into the HTTP routes channel as located bullets', () => {
    const out = renderComment(loadBlast('blast-result-http-cross-repo.json'), OPTS);
    expect(out).toContain('## Cross-Repo Impact');
    // 4 of the 5 findings are HTTP (graph/regex/declared/llm tiers); the 5th is a
    // plain import. The HTTP channel is a located bullet list, not the inline form.
    expect(out).toContain('**HTTP routes** (4):');
    expect(out).toContain('- `GET /api/repos/*/prs/*/refresh` — called from');
    expect(out).toContain('`POST /api/repos`');
    // the plain import edge stays in the Imported symbols channel.
    expect(out).toContain('**Imported symbols** (1):');
  });

  it('renders consumer call sites as escaped `file:line` lists with a (+N more) tail', () => {
    const out = renderComment(loadBlast('blast-result-http-cross-repo.json'), OPTS);
    // 2 call sites shown, consumerD1Count 4 → +2 more.
    expect(out).toContain('called from `src/hub-client.ts:118`, `src/hub-client.ts:205` (+2 more)');
  });

  it('renders a plain import edge with consumer line and its call site', () => {
    const out = renderComment(loadBlast('blast-result-http-cross-repo.json'), OPTS);
    expect(out).toContain('`BlastResult` (used in `src/types/blast-result.ts:217`)');
    expect(out).toContain('called from `src/render-comment.ts:12`');
  });

  it('renders the notYetKnowable caveat once, only when count > 0', () => {
    const out = renderComment(loadBlast('blast-result-http-cross-repo.json'), OPTS);
    expect(out).toContain(
      '_2 changed symbols are new in this PR — cross-repo impact not yet knowable._',
    );
    expect((out.match(/not yet knowable/g) ?? []).length).toBe(1);
  });

  it('surfaces the caveat even with no findings and no error (new-exports-only PR)', () => {
    const blast = withCross({
      schemaVersion: '1',
      findings: [],
      groups: [],
      truncated: false,
      error: null,
      notYetKnowable: [{ name: 'onlyNewExport' }],
    });
    const out = renderComment(blast, OPTS);
    expect(out).toContain('## Cross-Repo Impact');
    expect(out).toContain(
      '_1 changed symbol is new in this PR — cross-repo impact not yet knowable._',
    );
  });

  it('routes a via-prefixed symbol edge (no providerContract) into HTTP routes', () => {
    const blast = withCross({
      schemaVersion: '1',
      findings: [
        {
          kind: 'symbol',
          consumerRepo: 'org/consumer',
          consumerSymbol: { name: 'del', filePath: 'src/c.ts' },
          providerSymbol: null,
          via: 'http:DELETE /api/x',
          edgeType: 'FETCHES',
          detectionTier: 'tier3_http_graph',
          confidence: 0.9,
        },
      ],
      groups: [],
      truncated: false,
      error: null,
    });
    const out = renderComment(blast, OPTS);
    expect(out).toContain('**HTTP routes** (1):');
    expect(out).toContain('- `DELETE /api/x`');
  });

  it('escapes pipe characters in call-site file paths', () => {
    const blast = withCross({
      schemaVersion: '1',
      findings: [
        {
          kind: 'symbol',
          consumerRepo: 'org/consumer',
          consumerSymbol: { name: 'f', filePath: 'src/f.ts' },
          providerSymbol: null,
          via: 'http:GET /x',
          edgeType: 'FETCHES',
          detectionTier: 'tier3_http_graph',
          confidence: 0.9,
          providerContract: { kind: 'http', method: 'GET', path: '/x' },
          callSites: [{ filePath: 'src/a|b.ts', startLine: 5 }],
        },
      ],
      groups: [],
      truncated: false,
      error: null,
    });
    const out = renderComment(blast, OPTS);
    expect(out).toContain('src/a\\|b.ts:5');
  });

  it('renders a pending-rebuild / pre-lines caveat through the existing degraded-note path', () => {
    // The Hub sets these caveats on `error`; the Action renders the generic
    // degraded note (privacy: never echoes the raw error) and must not mangle or
    // throw on the em-dash-bearing pre-lines caveat.
    for (const caveat of [
      'group analysis in progress',
      'bridge predates the HTTP symbol tier — re-analyze the group',
    ]) {
      const blast = withCross({
        schemaVersion: '1',
        findings: [],
        groups: [],
        truncated: false,
        error: caveat,
      });
      expect(() => renderComment(blast, OPTS)).not.toThrow();
      const out = renderComment(blast, OPTS);
      expect(out).toContain('## Cross-Repo Impact');
      expect(out).toContain(
        '_Cross-repo analysis was incomplete, so some dependents may be missing._',
      );
      expect(out).toContain('_(cross-repo analysis unavailable)_');
    }
  });

  it('never throws on a malformed flow finding (missing flow object)', () => {
    const blast = withCross({
      schemaVersion: '1',
      findings: [
        {
          kind: 'flow',
          consumerRepo: '',
          via: 'broken pipeline',
          edgeType: 'STEP_IN_CROSS_PROCESS',
          detectionTier: 'process',
          confidence: 1,
        },
      ],
      groups: [],
      truncated: false,
      error: null,
    });
    expect(() => renderComment(blast, OPTS)).not.toThrow();
    const out = renderComment(blast, OPTS);
    expect(out).toContain('**Shared flows** (1):');
    expect(out).toContain('`broken pipeline`');
    expect(out).not.toContain('(step '); // no step clause when counters are absent
  });

  it('drops call-site detail (not the summary) as the payload degrades to capped', () => {
    // A huge changed-symbol list forces the renderer down to `capped`. The HTTP
    // route summary survives; the per-finding call-site lists are the detail that
    // degrades, and the headline is never evicted.
    const huge: SymbolRef[] = Array.from({ length: 20000 }, (_, i) => ({
      id: `s${i}`,
      name: `symbol_${i}_${'x'.repeat(40)}`,
      type: 'Function',
      filePath: `src/path/to/file_${i}.ts`,
      startLine: 1,
      endLine: 2,
    }));
    const base = loadBlast('blast-result-http-cross-repo.json');
    const blast = normalizeBlastResult({
      ...base,
      changedSymbols: huge,
    } as unknown as BlastResult);
    const out = renderComment(blast, OPTS);
    expect(out.length).toBeLessThanOrEqual(CHAR_BUDGET);
    expect(out).toContain('## Cross-Repo Impact');
    expect(out).toContain('**HTTP routes**');
    expect(out).not.toContain('called from'); // call-site detail dropped at capped
    expect(out).toContain('**HIGH blast radius**'); // headline survives
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

  it('replaces backticks so inline code spans stay intact', () => {
    const blast = normalizeBlastResult({
      blastLevel: 'LOW',
      changedSymbols: [
        {
          id: 'x',
          name: 'foo`bar',
          type: 'Function',
          filePath: 'src/`dir`/file.ts',
          startLine: 1,
          endLine: 2,
        },
      ],
      d1Symbols: [],
      d2Symbols: [],
      d3Symbols: [],
      affectedFlows: [],
      affectedModules: [{ name: 'mod`ule', hits: 1, direct: true }],
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
    expect(out).toContain('`foo\'bar`');
    expect(out).toContain('`src/\'dir\'/file.ts:1`');
    expect(out).toContain('| `mod\'ule` |');
    expect(out).not.toContain('`foo`bar`');
  });
});
