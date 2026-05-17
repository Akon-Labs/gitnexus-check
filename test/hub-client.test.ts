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
});
