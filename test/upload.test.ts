import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { pollUntilReady, runChecks } from '../src/upload';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const mockedAxios = vi.mocked(axios, true);

describe('pollUntilReady', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
  });

  it('returns indexedCommit when status becomes ready', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { status: 'pending' } })
      .mockResolvedValueOnce({ data: { status: 'ready', indexedCommit: 'deadbeef' } });

    const result = await pollUntilReady({
      statusUrl: '/api/repos/r1/reindex/job1',
      hubUrl: 'https://hub.example.com',
      token: 't',
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ indexedCommit: 'deadbeef' });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://hub.example.com/api/repos/r1/reindex/job1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });

  it('throws when status becomes error', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: { status: 'error', error: 'parse failed' },
    });

    await expect(
      pollUntilReady({
        statusUrl: '/x',
        hubUrl: 'https://hub.example.com',
        token: 't',
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/parse failed/);
  });
});

describe('runChecks', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
  });

  it('POSTs to the checks endpoint and returns the suite result', async () => {
    const suite = {
      prNumber: 42,
      checks: [],
      warRoomUrl: 'https://hub.example.com/prs/42',
      durationMs: 1234,
    };
    mockedAxios.post.mockResolvedValueOnce({ data: suite });

    const result = await runChecks({
      hubUrl: 'https://hub.example.com',
      token: 't',
      repoId: 'r1',
      prNumber: 42,
    });

    expect(result).toEqual(suite);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://hub.example.com/api/repos/r1/checks/42',
      {},
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      }),
    );
  });
});
