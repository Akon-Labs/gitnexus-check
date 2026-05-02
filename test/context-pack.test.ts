import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { fetchContextPack, resolveRepoId } from '../src/context-pack';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const mockedAxios = vi.mocked(axios, true);

describe('fetchContextPack', () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
  });

  it('POSTs the request body to /context-pack and returns the JSON', async () => {
    const pack = {
      schemaVersion: 1,
      repo: { id: 'r1', fullName: 'a/b', indexedCommit: null, lastIndexedAt: null },
      pr: { number: 7, branch: 'feat/x', headSha: 'h', baseSha: 'b' },
      diff: {
        filesChanged: 1,
        linesAdded: 10,
        linesDeleted: 0,
        isBigDiff: false,
        containsRename: false,
        files: [],
      },
      changedSymbols: [],
      groups: [],
      crossRepoConsumers: [],
      boundaryCrossings: [],
      mcpHint: '',
      warningsForClaude: [],
    };
    mockedAxios.post.mockResolvedValueOnce({ data: pack });

    const result = await fetchContextPack({
      hubUrl: 'https://hub.example.com',
      token: 't',
      repoId: 'r1',
      request: {
        prNumber: 7,
        headSha: 'h',
        baseSha: 'b',
        branch: 'feat/x',
        url: 'https://github.com/a/b/pull/7',
        diff: {
          files: [{ path: 'src/a.ts', status: 'modified', added: 10, deleted: 0 }],
        },
      },
    });

    expect(result).toEqual(pack);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://hub.example.com/api/repos/r1/context-pack',
      expect.objectContaining({
        prNumber: 7,
        headSha: 'h',
        baseSha: 'b',
        branch: 'feat/x',
        url: 'https://github.com/a/b/pull/7',
        diff: expect.objectContaining({
          files: [{ path: 'src/a.ts', status: 'modified', added: 10, deleted: 0 }],
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});

describe('resolveRepoId', () => {
  beforeEach(() => {
    mockedAxios.get.mockReset();
  });

  it('returns the repo id from camelCase fullName', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        repos: [
          { id: 'r1', fullName: 'a/b' },
          { id: 'r2', fullName: 'x/y' },
        ],
      },
    });
    await expect(resolveRepoId({ hubUrl: 'https://h', token: 't', fullName: 'x/y' })).resolves.toBe(
      'r2',
    );
  });

  it('falls back to snake_case full_name (older Hub deployments)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        repos: [{ id: 'r9', full_name: 'a/b' }],
      },
    });
    await expect(resolveRepoId({ hubUrl: 'https://h', token: 't', fullName: 'a/b' })).resolves.toBe(
      'r9',
    );
  });

  it('throws when repo not registered', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { repos: [] } });
    await expect(
      resolveRepoId({ hubUrl: 'https://h', token: 't', fullName: 'a/b' }),
    ).rejects.toThrow(/not registered/);
  });
});
