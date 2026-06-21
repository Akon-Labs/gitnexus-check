import { describe, it, expect, vi } from 'vitest';
import { postOrUpdateComment, type IssueCommentsClient } from '../src/post-comment';

const MARKER = '<!-- gitnexus-review-v1 -->';
const BODY_OK = `${MARKER}\n## hi`;

interface MockOpts {
  pages?: Array<Array<{ id: number; body?: string }>>;
  createId?: number;
  updateId?: number;
  createImpl?: () => Promise<never>;
}

function makeClient(opts: MockOpts = {}): {
  client: IssueCommentsClient;
  spies: {
    iterator: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
  };
} {
  const pages = opts.pages ?? [[]];
  const iterator = vi.fn(async function* () {
    for (const page of pages) {
      yield { data: page };
    }
  });
  const createComment = vi.fn(
    opts.createImpl ?? (async () => ({ data: { id: opts.createId ?? 999 } })),
  );
  const updateComment = vi.fn(async () => ({ data: { id: opts.updateId ?? 999 } }));
  return {
    client: {
      paginate: { iterator: iterator as unknown as IssueCommentsClient['paginate']['iterator'] },
      rest: {
        issues: {
          createComment: createComment as unknown as IssueCommentsClient['rest']['issues']['createComment'],
          updateComment: updateComment as unknown as IssueCommentsClient['rest']['issues']['updateComment'],
        },
      },
    },
    spies: { iterator, createComment, updateComment },
  };
}

describe('postOrUpdateComment — create path', () => {
  it('creates a new comment when no existing match', async () => {
    const { client, spies } = makeClient({ pages: [[{ id: 1, body: 'random' }]], createId: 42 });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 42, action: 'created' });
    expect(spies.createComment).toHaveBeenCalledOnce();
    expect(spies.updateComment).not.toHaveBeenCalled();
  });

  it('skips comments that do not contain the marker', async () => {
    const { client } = makeClient({
      pages: [[{ id: 1, body: 'partial' }, { id: 2, body: 'another' }]],
      createId: 99,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res.action).toBe('created');
  });
});

describe('postOrUpdateComment — update path', () => {
  it('PATCHes when a marker-containing comment exists', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 1, body: 'random' }, { id: 77, body: `previous ${MARKER}` }]],
      updateId: 77,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 77, action: 'updated' });
    expect(spies.updateComment).toHaveBeenCalledOnce();
    expect(spies.createComment).not.toHaveBeenCalled();
  });

  it('matches across paginated pages', async () => {
    const { client, spies } = makeClient({
      pages: [
        [{ id: 1, body: 'a' }, { id: 2, body: 'b' }],
        [{ id: 3, body: 'c' }, { id: 4, body: `with ${MARKER} inside` }],
      ],
      updateId: 4,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 1,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res.commentId).toBe(4);
    expect(spies.updateComment).toHaveBeenCalledOnce();
  });

  it('falls through to create when MAX_PAGES (10) exhausted without a match', async () => {
    const pages: Array<Array<{ id: number; body?: string }>> = [];
    for (let p = 0; p < 15; p++) {
      const page: Array<{ id: number; body?: string }> = [];
      for (let i = 0; i < 100; i++) {
        page.push({ id: p * 100 + i, body: 'no marker here' });
      }
      pages.push(page);
    }
    const { client, spies } = makeClient({ pages, createId: 5000 });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 1,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 5000, action: 'created' });
    expect(spies.createComment).toHaveBeenCalledOnce();
  });
});

describe('postOrUpdateComment — per-SHA since-commit marker idempotency', () => {
  const SHA_MARKER = '<!-- gitnexus-since-commit:a1b2c3d4e5f6 -->';
  const SHA_BODY = `${SHA_MARKER}\n\n## 🔁 Since last commit (\`a1b2c3d\`)\nreworked it`;

  it('creates a new comment when the per-SHA marker is not present (new commit)', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 9, body: '<!-- gitnexus-review-v1 -->\nmain report' }]],
      createId: 321,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: SHA_MARKER,
      body: SHA_BODY,
    });
    expect(res).toEqual({ commentId: 321, action: 'created' });
    expect(spies.createComment).toHaveBeenCalledOnce();
    expect(spies.updateComment).not.toHaveBeenCalled();
  });

  it('updates in place on a same-SHA re-run (no duplicate)', async () => {
    const { client, spies } = makeClient({
      pages: [
        [
          { id: 9, body: '<!-- gitnexus-review-v1 -->\nmain report' },
          { id: 88, body: `previous ${SHA_MARKER} body` },
        ],
      ],
      updateId: 88,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: SHA_MARKER,
      body: SHA_BODY,
    });
    expect(res).toEqual({ commentId: 88, action: 'updated' });
    expect(spies.updateComment).toHaveBeenCalledOnce();
    expect(spies.createComment).not.toHaveBeenCalled();
  });

  it('the main v1 marker and a per-SHA marker upsert independently (coexist)', async () => {
    // A thread already holding the main comment AND a since-commit comment for a
    // DIFFERENT sha: a new sha's marker must miss both and create afresh.
    const { client, spies } = makeClient({
      pages: [
        [
          { id: 9, body: '<!-- gitnexus-review-v1 -->\nmain report' },
          { id: 10, body: '<!-- gitnexus-since-commit:ffffff0 -->\nolder delta' },
        ],
      ],
      createId: 654,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: SHA_MARKER, // a1b2c3d4e5f6 — not present
      body: SHA_BODY,
    });
    expect(res).toEqual({ commentId: 654, action: 'created' });
    expect(spies.createComment).toHaveBeenCalledOnce();
  });
});

describe('postOrUpdateComment — error handling', () => {
  it('propagates GitHub 403 errors (caller will classifyError)', async () => {
    const err = new Error('forbidden');
    Object.assign(err, { isAxiosError: false, response: { status: 403 } });
    const { client } = makeClient({
      createImpl: async () => {
        throw err;
      },
    });
    await expect(
      postOrUpdateComment({
        client,
        owner: 'a',
        repo: 'b',
        prNumber: 1,
        marker: MARKER,
        body: BODY_OK,
      }),
    ).rejects.toThrow('forbidden');
  });

  it('rejects bodies that do not contain the marker (defensive guard)', async () => {
    const { client } = makeClient();
    await expect(
      postOrUpdateComment({
        client,
        owner: 'a',
        repo: 'b',
        prNumber: 1,
        marker: MARKER,
        body: 'no marker',
      }),
    ).rejects.toThrow('body must contain marker');
  });

  it('validates owner / repo / prNumber shape', async () => {
    const { client } = makeClient();
    await expect(
      postOrUpdateComment({
        client,
        owner: 'bad owner!',
        repo: 'b',
        prNumber: 1,
        marker: MARKER,
        body: BODY_OK,
      }),
    ).rejects.toThrow('invalid owner');
    await expect(
      postOrUpdateComment({
        client,
        owner: 'a',
        repo: 'b',
        prNumber: -3,
        marker: MARKER,
        body: BODY_OK,
      }),
    ).rejects.toThrow('invalid prNumber');
  });
});
