import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isBlastResult,
  normalizeBlastResult,
  normalizeSinceLastCommit,
  EMPTY_CROSS_REPO,
  type BlastResult,
} from '../src/types/blast-result';

function loadFixture(name: string): unknown {
  const filePath = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

describe('isBlastResult', () => {
  it('accepts the full real-Hub fixture', () => {
    const full = loadFixture('blast-result-full.json');
    expect(isBlastResult(full)).toBe(true);
  });

  it('accepts the empty fixture', () => {
    const empty = loadFixture('blast-result-empty.json');
    expect(isBlastResult(empty)).toBe(true);
  });

  it('accepts the truncated fixture', () => {
    const trunc = loadFixture('blast-result-truncated.json');
    expect(isBlastResult(trunc)).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isBlastResult(null)).toBe(false);
    expect(isBlastResult(undefined)).toBe(false);
    expect(isBlastResult('string')).toBe(false);
    expect(isBlastResult(42)).toBe(false);
    expect(isBlastResult([])).toBe(false);
  });

  it('rejects when blastLevel is missing', () => {
    expect(isBlastResult({ truncated: false, computedAt: 'x' })).toBe(false);
  });

  it('rejects when truncated is not a boolean', () => {
    expect(isBlastResult({ blastLevel: 'LOW', truncated: 'no', computedAt: 'x' })).toBe(false);
  });

  it('rejects when computedAt is missing or non-string', () => {
    expect(isBlastResult({ blastLevel: 'LOW', truncated: false })).toBe(false);
    expect(isBlastResult({ blastLevel: 'LOW', truncated: false, computedAt: 5 })).toBe(false);
  });

  it('rejects when a known array field is a non-array, non-null value', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        changedSymbols: 'oops',
      }),
    ).toBe(false);
  });

  it('rejects when fileRiskLevel is a non-string non-null value', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        fileRiskLevel: 5,
      }),
    ).toBe(false);
  });

  it('tolerates absent optional array fields', () => {
    // Older Hub versions may omit some array fields entirely.
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
      }),
    ).toBe(true);
  });

  it('tolerates stale: null from older Hub rows without the column backfilled', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        stale: null,
      }),
    ).toBe(true);
  });

  it('rejects when stale is a non-boolean non-null value', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        stale: 'yes',
      }),
    ).toBe(false);
  });

  it('rejects when graphData is a non-object', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        graphData: 'oops',
      }),
    ).toBe(false);
  });

  it('accepts a fixture with a populated crossRepo envelope', () => {
    const cross = loadFixture('blast-result-cross-repo.json');
    expect(isBlastResult(cross)).toBe(true);
  });

  it('rejects when crossRepo is present as a string', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        crossRepo: 'oops',
      }),
    ).toBe(false);
  });

  it('rejects when crossRepo.findings is a non-array', () => {
    expect(
      isBlastResult({
        blastLevel: 'LOW',
        truncated: false,
        computedAt: 'x',
        crossRepo: { schemaVersion: '1', findings: 'x', groups: [], truncated: false, error: null },
      }),
    ).toBe(false);
  });

  it('accepts aiSummary as a string, null, or absent', () => {
    const base = { blastLevel: 'LOW', truncated: false, computedAt: 'x' };
    expect(isBlastResult({ ...base, aiSummary: '## Summary\nok' })).toBe(true);
    expect(isBlastResult({ ...base, aiSummary: null })).toBe(true);
    expect(isBlastResult(base)).toBe(true);
  });

  it('rejects when aiSummary is present as a non-string', () => {
    expect(
      isBlastResult({ blastLevel: 'LOW', truncated: false, computedAt: 'x', aiSummary: 123 }),
    ).toBe(false);
  });

  it('stays true when sinceLastCommit is absent (old Hub) or null', () => {
    const base = { blastLevel: 'LOW', truncated: false, computedAt: 'x' };
    expect(isBlastResult(base)).toBe(true);
    expect(isBlastResult({ ...base, sinceLastCommit: null })).toBe(true);
    expect(
      isBlastResult({ ...base, sinceLastCommit: { headSha: 'abc1234', summary: 'fix' } }),
    ).toBe(true);
  });

  it('tolerates a partial sinceLastCommit object (normalize is the gate, not the guard)', () => {
    const base = { blastLevel: 'LOW', truncated: false, computedAt: 'x' };
    // A present object passes the tolerant guard even when fields are missing;
    // normalizeSinceLastCommit is what collapses it to null later.
    expect(isBlastResult({ ...base, sinceLastCommit: {} })).toBe(true);
    expect(isBlastResult({ ...base, sinceLastCommit: { headSha: 'abc1234' } })).toBe(true);
  });

  it('rejects when sinceLastCommit is present as a non-object, non-null value', () => {
    const base = { blastLevel: 'LOW', truncated: false, computedAt: 'x' };
    expect(isBlastResult({ ...base, sinceLastCommit: 'oops' })).toBe(false);
    expect(isBlastResult({ ...base, sinceLastCommit: 42 })).toBe(false);
  });
});

describe('normalizeSinceLastCommit', () => {
  it('keeps a valid {headSha, summary}', () => {
    expect(
      normalizeSinceLastCommit({ headSha: 'a1b2c3d4e5f6', summary: 'tightened the guard' }),
    ).toEqual({ headSha: 'a1b2c3d4e5f6', summary: 'tightened the guard' });
  });

  it('returns null for absent / null / non-object values', () => {
    expect(normalizeSinceLastCommit(undefined)).toBeNull();
    expect(normalizeSinceLastCommit(null)).toBeNull();
    expect(normalizeSinceLastCommit('oops')).toBeNull();
    expect(normalizeSinceLastCommit(42)).toBeNull();
    expect(normalizeSinceLastCommit([])).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    expect(normalizeSinceLastCommit({})).toBeNull();
    expect(normalizeSinceLastCommit({ headSha: 'abc1234' })).toBeNull();
    expect(normalizeSinceLastCommit({ summary: 'fix' })).toBeNull();
  });

  it('returns null for empty-string headSha or summary', () => {
    expect(normalizeSinceLastCommit({ headSha: '', summary: 'fix' })).toBeNull();
    expect(normalizeSinceLastCommit({ headSha: 'abc1234', summary: '' })).toBeNull();
  });

  it('returns null for non-string headSha or summary', () => {
    expect(normalizeSinceLastCommit({ headSha: 123, summary: 'fix' })).toBeNull();
    expect(normalizeSinceLastCommit({ headSha: 'abc1234', summary: 123 })).toBeNull();
  });
});

describe('normalizeBlastResult', () => {
  it('fills missing arrays with []', () => {
    const partial = {
      blastLevel: 'LOW',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    const out = normalizeBlastResult(partial);
    expect(out.changedSymbols).toEqual([]);
    expect(out.d1Symbols).toEqual([]);
    expect(out.d2Symbols).toEqual([]);
    expect(out.d3Symbols).toEqual([]);
    expect(out.affectedFlows).toEqual([]);
    expect(out.affectedModules).toEqual([]);
    expect(out.changedFiles).toEqual([]);
    expect(out.riskFiles).toEqual([]);
    expect(out.graphData).toEqual({ nodes: [], links: [] });
    expect(out.stale).toBe(false);
    expect(out.prTitle).toBeNull();
  });

  it('treats stale: null as false', () => {
    const v = {
      blastLevel: 'LOW',
      truncated: false,
      computedAt: 'x',
      stale: null,
    } as unknown as BlastResult;
    expect(normalizeBlastResult(v).stale).toBe(false);
  });

  it('clamps unknown blastLevel to LOW', () => {
    const v = {
      blastLevel: 'NUCLEAR',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    expect(normalizeBlastResult(v).blastLevel).toBe('LOW');
  });

  it('preserves a valid CRITICAL level', () => {
    const v = {
      blastLevel: 'CRITICAL',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    expect(normalizeBlastResult(v).blastLevel).toBe('CRITICAL');
  });

  it('drops unknown fileRiskLevel values to null', () => {
    const v = {
      blastLevel: 'LOW',
      fileRiskLevel: 'WEIRD',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    expect(normalizeBlastResult(v).fileRiskLevel).toBeNull();
  });

  it('round-trips a populated crossRepo envelope, preserving findings and groups', () => {
    const cross = loadFixture('blast-result-cross-repo.json');
    expect(isBlastResult(cross)).toBe(true);
    const out = normalizeBlastResult(cross as BlastResult);
    expect(out.crossRepo).toBeDefined();
    expect(out.crossRepo?.schemaVersion).toBe('1');
    expect(out.crossRepo?.findings).toHaveLength(1);
    expect(out.crossRepo?.groups).toHaveLength(1);
    const [finding] = out.crossRepo?.findings as Array<{ consumerRepo: string }>;
    expect(finding.consumerRepo).toBe('acme/widget-web');
    const [group] = out.crossRepo?.groups as Array<{ name: string }>;
    expect(group.name).toBe('Acme Platform');
  });

  it('passes through a string aiSummary and defaults missing/non-string to null', () => {
    const base = {
      blastLevel: 'LOW',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    expect(normalizeBlastResult({ ...base, aiSummary: '## Summary' }).aiSummary).toBe('## Summary');
    expect(normalizeBlastResult(base).aiSummary).toBeNull();
    expect(
      normalizeBlastResult({ ...base, aiSummary: 123 as unknown as string }).aiSummary,
    ).toBeNull();
  });

  it('fills a missing crossRepo with the EMPTY_CROSS_REPO zero-state', () => {
    const v = {
      blastLevel: 'LOW',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    expect(normalizeBlastResult(v).crossRepo).toEqual(EMPTY_CROSS_REPO);
  });

  it('round-trips the since-commit fixture, preserving the delta and digest', () => {
    const v = loadFixture('blast-result-since-commit.json');
    expect(isBlastResult(v)).toBe(true);
    const out = normalizeBlastResult(v as BlastResult);
    expect(out.sinceLastCommit).toEqual({
      headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      summary: '🔁 Replaced the unchecked cast with a typed guard in `parse()`.',
    });
    expect(out.aiSummary).toContain('## Summary');
  });

  it('gates sinceLastCommit through normalizeSinceLastCommit (valid kept, partial → null)', () => {
    const base = {
      blastLevel: 'LOW',
      truncated: false,
      computedAt: 'x',
    } as unknown as BlastResult;
    expect(normalizeBlastResult(base).sinceLastCommit).toBeNull();
    expect(
      normalizeBlastResult({
        ...base,
        sinceLastCommit: { headSha: 'a1b2c3d', summary: 'fixed it' },
      } as unknown as BlastResult).sinceLastCommit,
    ).toEqual({ headSha: 'a1b2c3d', summary: 'fixed it' });
    expect(
      normalizeBlastResult({
        ...base,
        sinceLastCommit: { headSha: 'a1b2c3d' },
      } as unknown as BlastResult).sinceLastCommit,
    ).toBeNull();
  });
});

describe('crossRepo HTTP symbol tier through normalize', () => {
  const base = {
    blastLevel: 'HIGH',
    truncated: false,
    computedAt: 'x',
  } as unknown as BlastResult;

  it('carries notYetKnowable through verbatim when it is an array', () => {
    const nyk = [{ name: 'newExport', filePath: 'src/a.ts' }];
    const out = normalizeBlastResult({
      ...base,
      crossRepo: {
        schemaVersion: '1',
        findings: [],
        groups: [],
        truncated: false,
        error: null,
        notYetKnowable: nyk,
      },
    } as unknown as BlastResult);
    expect(out.crossRepo?.notYetKnowable).toEqual(nyk);
  });

  it('omits notYetKnowable (never coerces to []) for a non-array / malformed value', () => {
    const out = normalizeBlastResult({
      ...base,
      crossRepo: {
        schemaVersion: '1',
        findings: [],
        groups: [],
        truncated: false,
        error: null,
        notYetKnowable: 'oops',
      },
    } as unknown as BlastResult);
    expect(out.crossRepo?.notYetKnowable).toBeUndefined();
    // Absent (zero-state) crossRepo also has no notYetKnowable key.
    expect(normalizeBlastResult(base).crossRepo?.notYetKnowable).toBeUndefined();
  });

  it('preserves the additive symbol fields (providerContract, callSites, consumerD1Count, startLine)', () => {
    const finding = {
      kind: 'symbol',
      consumerRepo: 'org/consumer',
      consumerSymbol: { name: 'refreshPr', filePath: 'src/hub-client.ts', startLine: 118 },
      providerSymbol: { name: 'refreshBlast', filePath: 'src/routes/blast.ts', symbolLabel: 'Route' },
      via: 'http:GET /api/repos/*/prs/*/refresh',
      edgeType: 'FETCHES',
      detectionTier: 'tier3_http_graph',
      confidence: 0.9,
      providerContract: { kind: 'http', method: 'GET', path: '/api/repos/*/prs/*/refresh' },
      callSites: [{ filePath: 'src/hub-client.ts', startLine: 118 }],
      consumerD1Count: 4,
    };
    const out = normalizeBlastResult({
      ...base,
      crossRepo: { schemaVersion: '1', findings: [finding], groups: [], truncated: false, error: null },
    } as unknown as BlastResult);
    expect(out.crossRepo?.findings[0]).toEqual(finding);
  });

  it('degrading an unknown schemaVersion drops notYetKnowable with the findings', () => {
    const out = normalizeBlastResult({
      ...base,
      crossRepo: {
        schemaVersion: '9',
        findings: [],
        groups: [],
        truncated: false,
        error: null,
        notYetKnowable: [{ name: 'x' }],
      },
    } as unknown as BlastResult);
    expect(out.crossRepo?.error).toContain('unsupported crossRepo schema version: 9');
    expect(out.crossRepo?.notYetKnowable).toBeUndefined();
  });
});

describe('AffectedFlow shape through normalize', () => {
  it('preserves the tightened optional flow fields verbatim', () => {
    const v = {
      blastLevel: 'CRITICAL',
      truncated: false,
      computedAt: 'x',
      affectedFlows: [
        {
          processId: 'proc-1',
          processName: 'Indexing Queue Lifecycle',
          hitSymbols: ['enqueueJob', 'drainQueue'],
          hitCount: 7,
        },
        { name: 'legacy-flow' },
      ],
    } as unknown as BlastResult;
    const out = normalizeBlastResult(v);
    expect(out.affectedFlows).toHaveLength(2);
    const [first, second] = out.affectedFlows;
    expect(first.processId).toBe('proc-1');
    expect(first.processName).toBe('Indexing Queue Lifecycle');
    expect(first.hitSymbols).toEqual(['enqueueJob', 'drainQueue']);
    expect(first.hitCount).toBe(7);
    expect(second.name).toBe('legacy-flow');
    expect(second.processName).toBeUndefined();
  });
});
