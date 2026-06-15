/**
 * @brief: Pure opt-in gate logic for the action. Translates the
 *         `fail-on-blast-level` input into a typed threshold and decides
 *         whether a given blast level should fail the workflow. Contains no
 *         I/O and no `core.*` calls (§4.3/§5) — main.ts owns the side
 *         effects; this module is fully unit-testable.
 */

import type { BlastLevel } from './types/blast-result';

/**
 * @brief: Outcome of a gate evaluation. `neutral` means the gate is
 *         advisory (no threshold configured) and must never fail the run.
 */
export type GateDecision = 'pass' | 'fail' | 'neutral';

/**
 * @brief: Total order over blast levels so a threshold comparison is a
 *         simple numeric `>=`. LOW is least severe, CRITICAL most severe.
 */
const LEVEL_ORDER: Record<BlastLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * @brief: Parse the raw `fail-on-blast-level` input into a threshold. An
 *         empty/whitespace value means the gate is advisory and is mapped
 *         to `null`. A valid uppercase level maps to itself. Any other
 *         value is rejected so a typo fails the run fast rather than
 *         silently disabling the gate. Matching is strict-uppercase by
 *         design: lowercase is treated as a typo, not a convenience.
 *
 * @params: (raw: string) -> The unvalidated action input value.
 *
 * @returns: BlastLevel | null — the threshold, or null when advisory.
 * @throws: Error('fail-on-blast-level: invalid value "X" — expected LOW, MEDIUM, HIGH, or CRITICAL')
 *          when raw is non-empty but not one of the four uppercase levels.
 */
export function parseThreshold(raw: string): BlastLevel | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed === 'LOW' || trimmed === 'MEDIUM' || trimmed === 'HIGH' || trimmed === 'CRITICAL') {
    return trimmed;
  }
  throw new Error(
    `fail-on-blast-level: invalid value "${trimmed}" — expected LOW, MEDIUM, HIGH, or CRITICAL`,
  );
}

/**
 * @brief: Decide the gate outcome for a blast level against a threshold.
 *         A null threshold is advisory and always yields `neutral`. With a
 *         threshold set, the gate fails when the blast level MEETS OR
 *         EXCEEDS the threshold (`>=` in LEVEL_ORDER), otherwise passes.
 *
 * @params: (opts.blastLevel: BlastLevel)        -> Hub-reported overall blast level.
 * @params: (opts.threshold: BlastLevel | null)  -> Parsed threshold; null = advisory.
 *
 * @returns: GateDecision — 'neutral' when advisory, else 'fail' on meet-or-exceed, else 'pass'.
 */
export function evaluateGate(opts: {
  blastLevel: BlastLevel;
  threshold: BlastLevel | null;
}): GateDecision {
  if (opts.threshold === null) return 'neutral';
  return LEVEL_ORDER[opts.blastLevel] >= LEVEL_ORDER[opts.threshold] ? 'fail' : 'pass';
}
