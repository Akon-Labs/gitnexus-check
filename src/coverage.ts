/**
 * Coverage upload helpers — Phase 15 Task 15.4 (action side).
 *
 * Two pieces of work:
 *
 *   1. findCoverageFile(workdir, explicitPath?) — locate the
 *      coverage report on disk. If `explicitPath` is provided, just
 *      verify it exists. Otherwise probe a small list of common
 *      locations (Vitest/Jest, generic Cobertura, Maven/Gradle
 *      JaCoCo). Returns null if nothing is found — the caller
 *      should treat that as "user hasn't wired coverage yet" and
 *      skip the upload silently.
 *
 *   2. uploadCoverage({...}) — POST the file to
 *      /api/repos/:id/coverage with multipart form data. Mirrors
 *      uploadBundle in upload.ts so the two share auth / size
 *      conventions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import axios from 'axios';
import FormData from 'form-data';

/**
 * Probe paths in priority order. The order is meaningful: lcov is
 * the most common (Vitest/Jest default), so we hit it first to
 * avoid a half-dozen fs.existsSync calls in the happy path.
 */
const COMMON_COVERAGE_PATHS = [
  // istanbul / nyc / vitest / jest
  'coverage/lcov.info',
  // generic naming
  'coverage.xml',
  'cobertura-coverage.xml',
  'coverage/cobertura-coverage.xml',
  // Maven / Gradle JaCoCo
  'target/site/jacoco/jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml',
  'build/reports/jacoco/jacocoTestReport.xml',
] as const;

export function findCoverageFile(workdir: string, explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = path.resolve(workdir, explicitPath);
    return fs.existsSync(abs) ? abs : null;
  }
  for (const candidate of COMMON_COVERAGE_PATHS) {
    const abs = path.resolve(workdir, candidate);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

export interface UploadCoverageOpts {
  hubUrl: string;
  token: string;
  repoId: string;
  prNumber: number;
  commitSha: string;
  coveragePath: string;
  /** "auto" | "lcov" | "cobertura" | "jacoco". Defaults to "auto". */
  format?: string;
}

export interface CoverageUploadResult {
  status: string;
  format: string;
  filesCount: number;
  hitLinesCount: number;
  missedLinesCount: number;
}

export async function uploadCoverage(opts: UploadCoverageOpts): Promise<CoverageUploadResult> {
  const form = new FormData();
  form.append('prNumber', String(opts.prNumber));
  form.append('commitSha', opts.commitSha);
  form.append('format', opts.format ?? 'auto');
  form.append('coverage', fs.createReadStream(opts.coveragePath));

  const res = await axios.post(`${opts.hubUrl}/api/repos/${opts.repoId}/coverage`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${opts.token}` },
    maxContentLength: 25 * 1024 * 1024,
    maxBodyLength: 25 * 1024 * 1024,
  });
  return res.data;
}
