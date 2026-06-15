import { describe, it, expect } from 'vitest';
import { classifyError, SchemaMismatchError } from '../src/classify-error';

function axiosErr(opts: {
  status?: number;
  code?: string;
  url?: string;
  data?: unknown;
  headers?: Record<string, string>;
  message?: string;
}): unknown {
  const err: Record<string, unknown> = {
    isAxiosError: true,
    message: opts.message ?? 'Request failed',
    code: opts.code,
    config: { url: opts.url ?? 'https://hub.example.com/api/repos/x/prs/1' },
    response:
      opts.status === undefined && opts.data === undefined && opts.headers === undefined
        ? undefined
        : {
            status: opts.status,
            statusText: '',
            headers: opts.headers ?? {},
            data: opts.data,
          },
  };
  return err;
}

describe('classifyError — Hub context', () => {
  it('401 → invalid/revoked token', () => {
    expect(classifyError(axiosErr({ status: 401 }), 'hub')).toBe(
      'GNX_TOKEN is invalid or revoked. Regenerate at <hub>/profile.',
    );
  });

  it('402 → plan limit', () => {
    expect(classifyError(axiosErr({ status: 402 }), 'hub')).toBe(
      'Plan limit exceeded — upgrade at <hub>/billing.',
    );
  });

  it('403 generic → repo access', () => {
    expect(classifyError(axiosErr({ status: 403, data: { error: 'Forbidden' } }), 'hub')).toBe(
      'GNX_TOKEN does not have access to the requested repo on the Hub.',
    );
  });

  it('403 device-fingerprint missing → distinct message', () => {
    const err = axiosErr({
      status: 403,
      data: { error: 'Device tokens require X-Device-Fingerprint header. Use gnx connect to set up your editor.' },
    });
    expect(classifyError(err, 'hub')).toBe(
      'Hub requires X-Device-Fingerprint header for this token — Action build is incomplete.',
    );
  });

  it('404 on /api/repos → hub-url wrong', () => {
    const err = axiosErr({ status: 404, url: 'https://hub.example.com/api/repos' });
    expect(classifyError(err, 'hub')).toBe(
      'Hub /api/repos endpoint not found — hub-url may be wrong.',
    );
  });

  it('404 on /prs path → blast endpoint incompatible', () => {
    const err = axiosErr({ status: 404, url: 'https://hub.example.com/api/repos/abc/prs/1' });
    expect(classifyError(err, 'hub')).toBe(
      'Hub blast endpoint not found — Action version may be incompatible with Hub.',
    );
  });

  it('404 elsewhere → repo not registered', () => {
    const err = axiosErr({ status: 404, url: 'https://hub.example.com/api/repos/abc' });
    expect(classifyError(err, 'hub')).toBe(
      'Repo is not registered on the Hub. Link it at <hub>/repos.',
    );
  });

  it('429 with Retry-After → seconds included', () => {
    expect(
      classifyError(axiosErr({ status: 429, headers: { 'retry-after': '60' } }), 'hub'),
    ).toBe('Hub rate limit hit — retry after 60 seconds.');
  });

  it('429 without Retry-After → generic', () => {
    expect(classifyError(axiosErr({ status: 429 }), 'hub')).toBe(
      'Hub rate limit hit — retry shortly.',
    );
  });

  it('500 → hub error with status', () => {
    expect(classifyError(axiosErr({ status: 503 }), 'hub')).toBe(
      'Hub returned 503. Check Hub status.',
    );
  });

  it('ECONNABORTED → timeout', () => {
    expect(classifyError(axiosErr({ code: 'ECONNABORTED' }), 'hub')).toBe(
      'Hub request timed out. Check Hub availability.',
    );
  });

  it('ETIMEDOUT → timeout', () => {
    expect(classifyError(axiosErr({ code: 'ETIMEDOUT' }), 'hub')).toBe(
      'Hub request timed out. Check Hub availability.',
    );
  });

  it('ENOTFOUND → hub-url unresolvable', () => {
    expect(classifyError(axiosErr({ code: 'ENOTFOUND' }), 'hub')).toBe(
      'Hub URL could not be resolved — check the `hub-url` input.',
    );
  });

  it('HTML response body → wrong hub-url', () => {
    expect(
      classifyError(axiosErr({ status: 200, data: '<!DOCTYPE html><html><body>...' }), 'hub'),
    ).toBe('Hub returned HTML instead of JSON — hub-url may be wrong.');
  });

  it('SchemaMismatchError → standard schema message', () => {
    expect(classifyError(new SchemaMismatchError('blast'), 'hub')).toBe(
      'Hub returned unexpected response shape. Action and Hub may be on incompatible versions.',
    );
  });
});

describe('classifyError — GitHub context', () => {
  it('403 → missing permission', () => {
    expect(classifyError(axiosErr({ status: 403 }), 'github')).toBe(
      'Cannot post PR comment: missing pull-requests:write permission.',
    );
  });

  it('401 → bad GITHUB_TOKEN', () => {
    expect(classifyError(axiosErr({ status: 401 }), 'github')).toBe(
      'GITHUB_TOKEN is invalid — re-check the `github-token` input.',
    );
  });

  it('422 → comment body rejected', () => {
    expect(classifyError(axiosErr({ status: 422 }), 'github')).toBe(
      'Comment body rejected by GitHub (likely too large). Truncation failed — file an issue.',
    );
  });

  it('500 → retry hint', () => {
    expect(classifyError(axiosErr({ status: 500 }), 'github')).toBe(
      'GitHub returned 500. Try re-running the workflow.',
    );
  });
});

describe('classifyError — config context', () => {
  it('passes a plain Error message through unchanged', () => {
    const err = new Error(
      'fail-on-blast-level: invalid value "bogus" — expected LOW, MEDIUM, HIGH, or CRITICAL',
    );
    expect(classifyError(err, 'config')).toBe(
      'fail-on-blast-level: invalid value "bogus" — expected LOW, MEDIUM, HIGH, or CRITICAL',
    );
  });

  it('still scrubs gnx_ tokens from config messages', () => {
    const err = new Error('bad config near gnx_AAA111bbb222 token');
    const out = classifyError(err, 'config');
    expect(out).not.toContain('gnx_AAA111bbb222');
    expect(out).toContain('gnx_[redacted]');
  });

  it('falls back for a non-Error config throw', () => {
    expect(classifyError(42, 'config')).toBe('invalid configuration');
  });
});

describe('classifyError — non-axios errors', () => {
  it('plain Error → message returned', () => {
    expect(classifyError(new Error('boom'), 'hub')).toBe('boom');
  });

  it('unknown value → fallback string', () => {
    expect(classifyError(42, 'hub')).toBe('unknown error');
    expect(classifyError(null, 'hub')).toBe('unknown error');
    expect(classifyError(undefined, 'hub')).toBe('unknown error');
  });
});

describe('classifyError — token scrubbing', () => {
  it('strips gnx_… tokens from plain Error messages', () => {
    const err = new Error('auth failed for gnx_AAA111bbb222CCC');
    const out = classifyError(err, 'hub');
    expect(out).not.toContain('gnx_AAA111bbb222CCC');
    expect(out).toContain('gnx_[redacted]');
  });

  it('never returns the token value verbatim from any classified status', () => {
    const TOKEN = 'gnx_secrettokenvalue_zzz';
    const err = axiosErr({
      status: 401,
      message: `Request failed with auth ${TOKEN}`,
      data: { error: `bad token ${TOKEN}` },
    });
    const out = classifyError(err, 'hub');
    expect(out).not.toContain(TOKEN);
  });
});
