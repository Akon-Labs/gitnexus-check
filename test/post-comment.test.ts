import { describe, it, expect, vi } from 'vitest';
import { postOrUpdateComment, type IssueCommentsClient } from '../src/post-comment';

const MARKER = '<!-- gitnexus-review-v1 -->';
const BODY_OK = `${MARKER}\n## hi`;
// The author GitHub attaches to comments. `type: 'Bot'` is GitHub-set and
// unforgeable, so it is what lets the poster tell its own comment from a
// human-planted marker. `github-actions[bot]` is the default-token author.
const BOT_USER = { login: 'github-actions[bot]', type: 'Bot' };

type MockComment = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
};

interface MockOpts {
  pages?: Array<Array<MockComment>>;
  createId?: number;
  updateId?: number;
  createImpl?: () => Promise<never>;
  // Simulate the authenticated actor. Default resolves an empty login (→ null →
  // the [bot]-suffix heuristic), which is the GITHUB_TOKEN path.
  getAuthenticated?: () => Promise<{ data: { login?: string } }>;
}

function makeClient(opts: MockOpts = {}): {
  client: IssueCommentsClient;
  spies: {
    iterator: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
    getAuthenticated: ReturnType<typeof vi.fn>;
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
  const getAuthenticated = vi.fn(opts.getAuthenticated ?? (async () => ({ data: {} })));
  return {
    client: {
      paginate: { iterator: iterator as unknown as IssueCommentsClient['paginate']['iterator'] },
      rest: {
        issues: {
          createComment: createComment as unknown as IssueCommentsClient['rest']['issues']['createComment'],
          updateComment: updateComment as unknown as IssueCommentsClient['rest']['issues']['updateComment'],
        },
        users: {
          getAuthenticated:
            getAuthenticated as unknown as IssueCommentsClient['rest']['users']['getAuthenticated'],
        },
      },
    },
    spies: { iterator, createComment, updateComment, getAuthenticated },
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
      pages: [[{ id: 1, body: 'random' }, { id: 77, body: `previous ${MARKER}`, user: BOT_USER }]],
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
        [{ id: 3, body: 'c' }, { id: 4, body: `with ${MARKER} inside`, user: BOT_USER }],
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

describe('postOrUpdateComment — bot-identity filter', () => {
  it('ignores a marker planted by a human user and creates a fresh comment', async () => {
    // An attacker copies the public marker into their own comment to hijack the
    // Action's slot. type: 'User' (GitHub-set) must exclude it from adoption.
    const { client, spies } = makeClient({
      pages: [[
        { id: 660, body: `${MARKER}\nplanted by a human`, user: { login: 'attacker', type: 'User' } },
      ]],
      createId: 42,
    });
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

  it('adopts (PATCHes) a bot-authored marker comment', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 77, body: `${MARKER}\nprior report`, user: BOT_USER }]],
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

  it('adopts a GitHub App installation bot comment (login "<app>[bot]", type Bot)', async () => {
    // The github-token input may be an App installation token whose author is
    // "<app-slug>[bot]", not github-actions[bot]. The [bot]-suffix match keeps
    // the Action updating its own comment rather than duplicating it each run.
    const { client, spies } = makeClient({
      pages: [[
        { id: 91, body: `${MARKER}\nprior report`, user: { login: 'gitnexus-app[bot]', type: 'Bot' } },
      ]],
      updateId: 91,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 91, action: 'updated' });
    expect(spies.updateComment).toHaveBeenCalledOnce();
  });

  it('skips a human-planted marker even when it precedes the real bot comment', async () => {
    // Both carry the marker; the human decoy is listed first. Only the bot one
    // may be adopted, so the poster must scan past the decoy to comment 77.
    const { client, spies } = makeClient({
      pages: [[
        { id: 500, body: `${MARKER}\nhuman decoy`, user: { login: 'someone', type: 'User' } },
        { id: 77, body: `${MARKER}\nreal bot report`, user: BOT_USER },
      ]],
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
    expect(res.commentId).toBe(77);
    expect(spies.updateComment).toHaveBeenCalledOnce();
    expect(spies.createComment).not.toHaveBeenCalled();
  });

  it('ignores a marker comment with a null author (ghost user)', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 12, body: `${MARKER}\nauthorless`, user: null }]],
      createId: 43,
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 43, action: 'created' });
    expect(spies.createComment).toHaveBeenCalledOnce();
  });
});

describe('postOrUpdateComment — authenticated actor (PAT) identity', () => {
  // A user-scoped PAT github-token authors comments as the USER (type 'User'),
  // not a [bot]. getAuthenticated resolves that login so upsert idempotency is
  // preserved by an EXACT login match rather than the bot heuristic (which would
  // miss it → duplicate every run).
  const asUser = (login: string) => async () => ({ data: { login } });

  it('adopts its OWN prior comment authored by a user-PAT (exact login match)', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 314, body: `${MARKER}\nprior report`, user: { login: 'pat-owner', type: 'User' } }]],
      updateId: 314,
      getAuthenticated: asUser('pat-owner'),
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 314, action: 'updated' });
    expect(spies.updateComment).toHaveBeenCalledOnce();
    expect(spies.createComment).not.toHaveBeenCalled();
  });

  it('does NOT adopt another bot’s marker comment when the actor is a known PAT', async () => {
    // github-actions[bot] would pass the bot heuristic, but the resolved actor is
    // a different login — exact-match must exclude it so we do not hijack it.
    const { client, spies } = makeClient({
      pages: [[{ id: 20, body: `${MARKER}\nsomeone else`, user: BOT_USER }]],
      createId: 55,
      getAuthenticated: asUser('pat-owner'),
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 55, action: 'created' });
    expect(spies.createComment).toHaveBeenCalledOnce();
    expect(spies.updateComment).not.toHaveBeenCalled();
  });

  it('still rejects a human-planted marker when the actor is a known PAT', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 9, body: `${MARKER}\nplanted`, user: { login: 'attacker', type: 'User' } }]],
      createId: 77,
      getAuthenticated: asUser('pat-owner'),
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
    expect(spies.updateComment).not.toHaveBeenCalled();
  });

  it('falls back to the bot heuristic when getAuthenticated fails (GITHUB_TOKEN 403)', async () => {
    const { client, spies } = makeClient({
      pages: [[{ id: 88, body: `${MARKER}\nprior`, user: BOT_USER }]],
      updateId: 88,
      getAuthenticated: async () => {
        throw new Error('403 Forbidden');
      },
    });
    const res = await postOrUpdateComment({
      client,
      owner: 'a',
      repo: 'b',
      prNumber: 7,
      marker: MARKER,
      body: BODY_OK,
    });
    expect(res).toEqual({ commentId: 88, action: 'updated' });
    expect(spies.updateComment).toHaveBeenCalledOnce();
  });
});

describe('postOrUpdateComment — per-SHA since-commit marker idempotency', () => {
  const SHA_MARKER = '<!-- gitnexus-since-commit:a1b2c3d4e5f6 -->';
  const SHA_BODY = `${SHA_MARKER}\n\n## Commit \`a1b2c3d\` summary\nreworked it`;

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
          { id: 9, body: '<!-- gitnexus-review-v1 -->\nmain report', user: BOT_USER },
          { id: 88, body: `previous ${SHA_MARKER} body`, user: BOT_USER },
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
