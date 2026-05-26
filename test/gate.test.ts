import { describe, it, expect } from 'vitest';
import { parseThreshold, evaluateGate } from '../src/gate';

describe('parseThreshold', () => {
  it('parses each valid uppercase level', () => {
    expect(parseThreshold('LOW')).toBe('LOW');
    expect(parseThreshold('MEDIUM')).toBe('MEDIUM');
    expect(parseThreshold('HIGH')).toBe('HIGH');
    expect(parseThreshold('CRITICAL')).toBe('CRITICAL');
  });

  it('maps an empty string to null (advisory)', () => {
    expect(parseThreshold('')).toBeNull();
  });

  it('maps a whitespace-only string to null (advisory)', () => {
    expect(parseThreshold('   ')).toBeNull();
    expect(parseThreshold('\t\n')).toBeNull();
  });

  it('trims surrounding whitespace around a valid level', () => {
    expect(parseThreshold('  HIGH  ')).toBe('HIGH');
  });

  it('throws on an unknown value', () => {
    expect(() => parseThreshold('NUCLEAR')).toThrow(
      'fail-on-blast-level: invalid value "NUCLEAR" — expected LOW, MEDIUM, HIGH, or CRITICAL',
    );
  });

  it('rejects lowercase (strict uppercase only)', () => {
    expect(() => parseThreshold('high')).toThrow('fail-on-blast-level: invalid value "high"');
    expect(() => parseThreshold('Low')).toThrow('fail-on-blast-level: invalid value "Low"');
  });
});

describe('evaluateGate', () => {
  it('returns neutral when threshold is null (advisory)', () => {
    expect(evaluateGate({ blastLevel: 'CRITICAL', threshold: null })).toBe('neutral');
  });

  it('passes when blast level is below the threshold', () => {
    expect(evaluateGate({ blastLevel: 'LOW', threshold: 'HIGH' })).toBe('pass');
    expect(evaluateGate({ blastLevel: 'MEDIUM', threshold: 'CRITICAL' })).toBe('pass');
  });

  it('fails on the equal boundary (meets-or-exceeds)', () => {
    expect(evaluateGate({ blastLevel: 'HIGH', threshold: 'HIGH' })).toBe('fail');
  });

  it('fails when blast level exceeds the threshold', () => {
    expect(evaluateGate({ blastLevel: 'CRITICAL', threshold: 'MEDIUM' })).toBe('fail');
  });

  it('fails for LOW @ LOW (lowest boundary still meets)', () => {
    expect(evaluateGate({ blastLevel: 'LOW', threshold: 'LOW' })).toBe('fail');
  });
});
