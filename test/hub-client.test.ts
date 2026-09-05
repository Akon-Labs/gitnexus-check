import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import axios from 'axios';
import {
  resolveRepoId,
  refreshBlast,
  getBlast,
  requestFindingReply,
  validateHubUrl,
  ACTION_DEVICE_FINGERPRINT,
} from '../src/hub-client';
import { SchemaMismatchError } from '../src/classify-error';

const mockedAxios = vi.mocked(axios, true);

function loadFullBlast(): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'blast-result-full.json'), 'utf8'),
  );
}

const HUB = 'https://hub.example.com';
const TOKEN = 'gnx_test_token_value';

beforeEach(() => {
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
});

describe('validateHubUrl', () => {
  it('strips trailing slash', () => {
    expect(validateHubUrl('https://hub.example.com/')).toBe('https://hub.example.com');
  });
  it('rejects http', () => {
    expect(() => validateHubUrl('http://hub.example.com')).toThrow('https://');
  });
  it('rejects garbage', () => {
    expect(() => validateHubUrl('not a url')).toThrow('https://');
  });
});

describe('resolveRepoId', () => {
  it('matches by fullName and returns id (bare-array response)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [
        { id: 'uuid-1', fullName: 'a/x' },
        { id: 'uuid-2', fullName: 'a/b' },
      ],
    });
    const id = await resolveRepoId({ hubUrl: HUB, token: TOKEN, fullName: 'a/b' });
    expect(id).toBe('uuid-2');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${HUB}/api/repos`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
          'X-Device-Fingerprint': ACTION_DEVICE_FINGERPRINT,
        }),
        timeout: expect.any(Number),
        maxContentLength: expect.any(Number),
        maxBodyLength: expect.any(Number),
      }),
    );
  });

  it('accepts the legacy { repos: [...] } envelope shape', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { repos: [{ id: 'uuid-3', fullName: 'a/b' }] },
    });
    const id = await resolveRepoId({ hubUrl: HUB, token: TOKEN, fullName: 'a/b' });
    expect(id).toBe('uuid-3');
  });

  it('throws when no repo matches', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });
    await expect(
      resolveRepoId({ hubUrl: HUB, token: TOKEN, fullName: 'a/missing' }),
    ).rejects.toThrow('not registered on Hub');
  });

  it('throws SchemaMismatchError on unexpected shape', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: 'not even json-shaped' });
    await expect(
      resolveRepoId({ hubUrl: HUB, token: TOKEN, fullName: 'a/b' }),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  it('validates fullName format defensively', async () => {
    await expect(
      resolveRepoId({ hubUrl: HUB, token: TOKEN, fullName: 'no-slash' }),
    ).rejects.toThrow('invalid repo full name');
  });
});

describe('refreshBlast', () => {
  it('POSTs to the /refresh path with Bearer auth', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { blastLevel: 'LOW' } });
    await refreshBlast({ hubUrl: HUB, token: TOKEN, repoId: 'abc-123', prNumber: 7 });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${HUB}/api/repos/abc-123/prs/7/refresh`,
      {},
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });

  it('validates repoId shape', async () => {
    await expect(
      refreshBlast({ hubUrl: HUB, token: TOKEN, repoId: 'not/a/uuid', prNumber: 1 }),
    ).rejects.toThrow('invalid repoId shape');
  });

  it('validates prNumber is positive integer', async () => {
    await expect(
      refreshBlast({ hubUrl: HUB, token: TOKEN, repoId: 'abc', prNumber: 0 }),
    ).rejects.toThrow('invalid prNumber');
  });

  it('sends the ?headSha= query param when a valid headSha is present', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { blastLevel: 'LOW' } });
    await refreshBlast({
      hubUrl: HUB,
      token: TOKEN,
      repoId: 'abc-123',
      prNumber: 7,
      headSha: 'a1b2c3d4e5f6',
    });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${HUB}/api/repos/abc-123/prs/7/refresh`,
      {},
      expect.objectContaining({ params: { headSha: 'a1b2c3d4e5f6' } }),
    );
  });

  it('omits params when no headSha is supplied', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { blastLevel: 'LOW' } });
    await refreshBlast({ hubUrl: HUB, token: TOKEN, repoId: 'abc-123', prNumber: 7 });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${HUB}/api/repos/abc-123/prs/7/refresh`,
      {},
      expect.objectContaining({ params: undefined }),
    );
  });

  it('throws on a present-but-malformed headSha', async () => {
    await expect(
      refreshBlast({
        hubUrl: HUB,
        token: TOKEN,
        repoId: 'abc-123',
        prNumber: 7,
        headSha: 'not-a-sha!!',
      }),
    ).rejects.toThrow('invalid headSha shape');
  });
});

describe('getBlast', () => {
  it('returns a normalised BlastResult on the real fixture', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: loadFullBlast() });
    const blast = await getBlast({
      hubUrl: HUB,
      token: TOKEN,
      repoId: 'abc-123',
      prNumber: 152,
    });
    expect(blast.blastLevel).toBe('LOW');
    expect(blast.changedSymbols.length).toBeGreaterThan(0);
    expect(blast.affectedModules[0].name).toBe('Scripts');
  });

  it('throws SchemaMismatchError when body is the wrong shape', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { unrelated: true } });
    await expect(
      getBlast({ hubUrl: HUB, token: TOKEN, repoId: 'abc-123', prNumber: 1 }),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  it('sends X-Device-Fingerprint header on every call', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: loadFullBlast() });
    await getBlast({ hubUrl: HUB, token: TOKEN, repoId: 'abc-123', prNumber: 152 });
    const call = mockedAxios.get.mock.calls[0];
    expect(call[1]).toMatchObject({
      headers: expect.objectContaining({
        'X-Device-Fingerprint': ACTION_DEVICE_FINGERPRINT,
      }),
    });
  });

  it('sends the ?headSha= query param when a valid headSha is present', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: loadFullBlast() });
    await getBlast({
      hubUrl: HUB,
      token: TOKEN,
      repoId: 'abc-123',
      prNumber: 152,
      headSha: 'a1b2c3d4e5f6',
    });
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({
      params: { headSha: 'a1b2c3d4e5f6' },
    });
  });

  it('omits params when no headSha is supplied', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: loadFullBlast() });
    await getBlast({ hubUrl: HUB, token: TOKEN, repoId: 'abc-123', prNumber: 152 });
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({ params: undefined });
  });

  it('throws on a present-but-malformed headSha', async () => {
    await expect(
      getBlast({
        hubUrl: HUB,
        token: TOKEN,
        repoId: 'abc-123',
        prNumber: 152,
        headSha: 'xyz',
      }),
    ).rejects.toThrow('invalid headSha shape');
  });
});

describe('requestFindingReply', () => {
  const repoId = '123e4567-e89b-12d3-a456-426614174000';
  const fingerprint = 'a'.repeat(64);
  const headSha = 'b'.repeat(40);
  const valid = {
    schemaVersion: '1',
    fingerprint,
    analyzedSha: headSha,
    verdict: 'supported',
    reply: 'The graph evidence supports this finding.',
    evidence: [{ path: 'src/index.ts', startLine: 42, kind: 'anchor' }],
  };

  it('posts the bounded question with shared auth and stable idempotency', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: valid });

    await expect(
      requestFindingReply({
        hubUrl: HUB,
        token: TOKEN,
        repoId,
        prNumber: 7,
        fingerprint,
        headSha,
        question: '  Why is this still reachable?  ',
        triggerCommentId: 901,
      }),
    ).resolves.toEqual(valid);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      `${HUB}/api/repos/${repoId}/prs/7/findings/${fingerprint}/reply`,
      {
        schemaVersion: '1',
        headSha,
        question: 'Why is this still reachable?',
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOKEN}`,
          'X-Device-Fingerprint': ACTION_DEVICE_FINGERPRINT,
          'Idempotency-Key': 'gitnexus-review-reply:v1:901',
        }),
      }),
    );
  });

  it('accepts the 8001-character sanitized wire maximum', async () => {
    const response = { ...valid, reply: 'x'.repeat(8_001) };
    mockedAxios.post.mockResolvedValueOnce({ data: response });
    await expect(
      requestFindingReply({
        hubUrl: HUB,
        token: TOKEN,
        repoId,
        prNumber: 7,
        fingerprint,
        headSha,
        question: 'why?',
        triggerCommentId: 901,
      }),
    ).resolves.toEqual(response);
  });

  it('rejects unsafe input before transport', async () => {
    await expect(
      requestFindingReply({
        hubUrl: HUB,
        token: TOKEN,
        repoId: 'not-a-uuid',
        prNumber: 7,
        fingerprint,
        headSha,
        question: 'why?',
        triggerCommentId: 901,
      }),
    ).rejects.toThrow('invalid repoId shape');
    await expect(
      requestFindingReply({
        hubUrl: HUB,
        token: TOKEN,
        repoId,
        prNumber: 7,
        fingerprint,
        headSha,
        question: 'x'.repeat(4_001),
        triggerCommentId: 901,
      }),
    ).rejects.toThrow('invalid question');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong schema', { ...valid, schemaVersion: '2' }],
    ['wrong fingerprint', { ...valid, fingerprint: 'c'.repeat(64) }],
    ['stale SHA', { ...valid, analyzedSha: 'd'.repeat(40) }],
    ['unknown verdict', { ...valid, verdict: 'maybe' }],
    ['oversize reply', { ...valid, reply: 'x'.repeat(8_002) }],
    ['too much evidence', { ...valid, evidence: Array(10).fill(valid.evidence[0]) }],
    ['invalid evidence path', { ...valid, evidence: [{ path: 'x'.repeat(501), startLine: 1, kind: 'caller' }] }],
  ])('rejects a malformed Hub response: %s', async (_label, response) => {
    mockedAxios.post.mockResolvedValueOnce({ data: response });
    await expect(
      requestFindingReply({
        hubUrl: HUB,
        token: TOKEN,
        repoId,
        prNumber: 7,
        fingerprint,
        headSha,
        question: 'why?',
        triggerCommentId: 901,
      }),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
  });
});
