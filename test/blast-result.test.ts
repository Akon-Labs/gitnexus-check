import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isBlastResult,
  normalizeBlastResult,
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
