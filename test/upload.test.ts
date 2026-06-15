import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { pollUntilReady } from '../src/upload';

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
      statusUrl: '/api/repos/r1/branch-reindex/42/status',
      hubUrl: 'https://hub.example.com',
      token: 't',
      timeoutMs: 10_000,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ indexedCommit: 'deadbeef' });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://hub.example.com/api/repos/r1/branch-reindex/42/status',
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
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/parse failed/);
  });

  it('throws on timeout when status never becomes ready', async () => {
    mockedAxios.get.mockResolvedValue({ data: { status: 'pending' } });
    await expect(
      pollUntilReady({
        statusUrl: '/x',
        hubUrl: 'https://hub.example.com',
        token: 't',
        // Effectively zero — first iteration's elapsed is already > timeout.
        timeoutMs: 1,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
