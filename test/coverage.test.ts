import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import axios from 'axios';
import { findCoverageFile, uploadCoverage } from '../src/coverage';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

const mockedAxios = vi.mocked(axios, true);

describe('findCoverageFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when nothing exists', () => {
    expect(findCoverageFile(tmp)).toBeNull();
  });

  it('returns the explicit path when it exists', () => {
    const target = path.join(tmp, 'my-cov.lcov');
    fs.writeFileSync(target, 'TN:\nSF:x.ts\n');
    expect(findCoverageFile(tmp, 'my-cov.lcov')).toBe(target);
  });

  it('returns null when the explicit path does not exist', () => {
    expect(findCoverageFile(tmp, 'missing.xml')).toBeNull();
  });

  it('auto-detects lcov.info under coverage/', () => {
    fs.mkdirSync(path.join(tmp, 'coverage'), { recursive: true });
    const target = path.join(tmp, 'coverage', 'lcov.info');
    fs.writeFileSync(target, 'TN:\n');
    expect(findCoverageFile(tmp)).toBe(target);
  });

  it('auto-detects coverage.xml at the repo root', () => {
    const target = path.join(tmp, 'coverage.xml');
    fs.writeFileSync(target, '<coverage/>');
    expect(findCoverageFile(tmp)).toBe(target);
  });

  it('auto-detects Maven JaCoCo report', () => {
    const dir = path.join(tmp, 'target', 'site', 'jacoco');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'jacoco.xml');
    fs.writeFileSync(target, '<report/>');
    expect(findCoverageFile(tmp)).toBe(target);
  });

  it('explicit path takes priority over auto-detect', () => {
    // Both files exist — explicit should win even though it appears
    // later in COMMON_PATHS than coverage/lcov.info would.
    fs.mkdirSync(path.join(tmp, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'coverage', 'lcov.info'), 'TN:\n');
    const explicit = path.join(tmp, 'custom.xml');
    fs.writeFileSync(explicit, '<coverage/>');
    expect(findCoverageFile(tmp, 'custom.xml')).toBe(explicit);
  });
});

describe('uploadCoverage', () => {
  let tmp: string;
  let coverageFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-upload-'));
    coverageFile = path.join(tmp, 'lcov.info');
    fs.writeFileSync(coverageFile, 'TN:\nSF:x.ts\nDA:1,1\nend_of_record\n');
    mockedAxios.post.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('POSTs to /api/repos/:id/coverage with auth header and form data', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        status: 'ok',
        format: 'lcov',
        filesCount: 1,
        hitLinesCount: 1,
        missedLinesCount: 0,
      },
    });

    const result = await uploadCoverage({
      hubUrl: 'https://hub.example.com',
      token: 't',
      repoId: 'r1',
      prNumber: 42,
      commitSha: 'abc',
      coveragePath: coverageFile,
      format: 'auto',
    });

    expect(result.status).toBe('ok');
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, form, opts] = mockedAxios.post.mock.calls[0];
    expect(url).toBe('https://hub.example.com/api/repos/r1/coverage');
    expect(opts.headers).toMatchObject({ Authorization: 'Bearer t' });
    expect(opts.headers['content-type']).toMatch(/multipart\/form-data/);
    // Body limits match the route's 25MB cap.
    expect(opts.maxContentLength).toBe(25 * 1024 * 1024);
    expect(opts.maxBodyLength).toBe(25 * 1024 * 1024);
    // form-data instance carries the boundary; verifying via headers.
    expect(opts.headers['content-type']).toContain('boundary=');
    // Sanity check the form has the expected scalar fields registered
    // (non-stream fields show up in _streams as Buffers we can sniff).
    const streams = (form as any)._streams as Array<unknown>;
    const flat = streams
      .filter((s) => typeof s === 'string' || Buffer.isBuffer(s))
      .map((s) => (Buffer.isBuffer(s) ? s.toString() : (s as string)))
      .join('\n');
    expect(flat).toContain('name="prNumber"');
    expect(flat).toContain('42');
    expect(flat).toContain('name="commitSha"');
    expect(flat).toContain('abc');
    expect(flat).toContain('name="format"');
    expect(flat).toContain('auto');
    expect(flat).toContain('name="coverage"');
  });

  it('defaults format to "auto" when omitted', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { status: 'ok' } });
    await uploadCoverage({
      hubUrl: 'https://hub.example.com',
      token: 't',
      repoId: 'r1',
      prNumber: 1,
      commitSha: 'sha',
      coveragePath: coverageFile,
    });
    const [, form] = mockedAxios.post.mock.calls[0];
    const streams = (form as any)._streams as Array<unknown>;
    const flat = streams
      .filter((s) => typeof s === 'string' || Buffer.isBuffer(s))
      .map((s) => (Buffer.isBuffer(s) ? s.toString() : (s as string)))
      .join('\n');
    expect(flat).toContain('auto');
  });
});
