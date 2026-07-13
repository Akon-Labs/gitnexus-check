import { describe, it, expect, vi } from 'vitest';
import { reconcileFindings, type ReviewClient } from '../src/post-review';
import { findingMarker, renderFindingComment } from '../src/render-findings';
import type { FindingItem } from '../src/types/blast-result';

// GitHub-set, unforgeable author identity. type: 'Bot' + '[bot]' login is what
// lets the reconciler tell its own comment from a human-planted marker.
const BOT_USER = { login: 'github-actions[bot]', type: 'Bot' };

type MockComment = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
};
type MockReview = { id: number; state?: string; user?: { login?: string; type?: string } | null };

interface MockOpts {
  commentPages?: MockComment[][];
  reviews?: MockReview[];
  createImpl?: (params: {
    comments?: Array<{ path: string; line: number; side: string; body: string }>;
  }) => Promise<{ data: { id: number } }>;
  createId?: number;
  // Simulate the authenticated actor. Default resolves an empty login (→ null →
  // the [bot]-suffix heuristic), which is the GITHUB_TOKEN path.
  getAuthenticated?: () => Promise<{ data: { login?: string } }>;
}

function makeClient(opts: MockOpts = {}) {
  const pages = opts.commentPages ?? [[]];
  const iterator = vi.fn(async function* () {
    for (const page of pages) yield { data: page };
  });
  const listReviews = vi.fn(async () => ({ data: opts.reviews ?? [] }));
  const createReview = vi.fn(
    opts.createImpl ?? (async () => ({ data: { id: opts.createId ?? 1000 } })),
  );
  const updateReviewComment = vi.fn(async () => ({ data: { id: 0 } }));
  const deletePendingReview = vi.fn(async () => ({ data: {} }));
  const getAuthenticated = vi.fn(opts.getAuthenticated ?? (async () => ({ data: {} })));

  const client: ReviewClient = {
    paginate: { iterator: iterator as unknown as ReviewClient['paginate']['iterator'] },
    rest: {
      pulls: {
        listReviews: listReviews as unknown as ReviewClient['rest']['pulls']['listReviews'],
        createReview: createReview as unknown as ReviewClient['rest']['pulls']['createReview'],
        updateReviewComment:
          updateReviewComment as unknown as ReviewClient['rest']['pulls']['updateReviewComment'],
        deletePendingReview:
          deletePendingReview as unknown as ReviewClient['rest']['pulls']['deletePendingReview'],
      },
      users: {
        getAuthenticated:
          getAuthenticated as unknown as ReviewClient['rest']['users']['getAuthenticated'],
      },
    },
  };
  return {
    client,
    spies: { iterator, listReviews, createReview, updateReviewComment, deletePendingReview, getAuthenticated },
  };
}

function makeItem(overrides: Partial<FindingItem> = {}): FindingItem {
  return {
    fingerprint: 'fp',
    checkId: 'chk',
    origin: 'deterministic',
    severity: 'error',
    confidence: 1,
    title: 'title',
    rationale: 'rationale',
    path: 'src/foo.ts',
    anchored: true,
    anchor: { startLine: 10, endLine: 10 },
    ...overrides,
  };
}

const REPO = { owner: 'o', repo: 'r', prNumber: 5 };

describe('reconcileFindings — batch create (new findings)', () => {
  it('posts ONE batched review with commit_id === analyzedSha and RIGHT-side anchors', async () => {
    const item = makeItem({ fingerprint: 'a', path: 'src/a.ts', anchor: { startLine: 12, endLine: 12 } });
    const { client, spies } = makeClient();
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha123', items: [item] });

    expect(res).toEqual({ posted: 1, updated: 0, failed: [] });
    expect(spies.createReview).toHaveBeenCalledOnce();
    const call = spies.createReview.mock.calls[0][0] as {
      commit_id: string;
      event: string;
      comments: Array<{ path: string; line: number; side: string; body: string }>;
    };
    expect(call.commit_id).toBe('sha123');
    expect(call.event).toBe('COMMENT');
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0]).toMatchObject({ path: 'src/a.ts', line: 12, side: 'RIGHT' });
    expect(call.comments[0].body).toContain('gitnexus-finding:v1:a');
  });

  it('filters out non-anchored items (they are the fallback section’s job)', async () => {
    const anchored = makeItem({ fingerprint: 'a' });
    const notAnchored = makeItem({ fingerprint: 'n', anchored: false, anchor: undefined });
    const { client, spies } = makeClient();
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [anchored, notAnchored] });
    expect(res.posted).toBe(1);
    const call = spies.createReview.mock.calls[0][0] as { comments: unknown[] };
    expect(call.comments).toHaveLength(1);
  });

  it('does nothing (no network) when there are no items', async () => {
    const { client, spies } = makeClient();
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [] });
    expect(res).toEqual({ posted: 0, updated: 0, failed: [] });
    expect(spies.listReviews).not.toHaveBeenCalled();
    expect(spies.createReview).not.toHaveBeenCalled();
  });

  it('posts NOTHING and returns all items as failed when analyzedSha is null (never default-latest)', async () => {
    const item = makeItem();
    const { client, spies } = makeClient();
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: null, items: [item] });
    expect(res.posted).toBe(0);
    expect(res.failed).toEqual([item]);
    expect(spies.createReview).not.toHaveBeenCalled();
    expect(spies.listReviews).not.toHaveBeenCalled();
  });
});

describe('reconcileFindings — reconcile existing comments', () => {
  it('PATCHes a bot comment whose body changed (same fingerprint)', async () => {
    const item = makeItem({ fingerprint: 'b' });
    const existing = { id: 77, body: `${findingMarker('b')}\nstale body`, user: BOT_USER };
    const { client, spies } = makeClient({ commentPages: [[existing]] });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });

    expect(res).toEqual({ posted: 0, updated: 1, failed: [] });
    expect(spies.updateReviewComment).toHaveBeenCalledOnce();
    expect((spies.updateReviewComment.mock.calls[0][0] as { comment_id: number }).comment_id).toBe(77);
    expect(spies.createReview).not.toHaveBeenCalled();
  });

  it('no-ops when the existing bot comment body already matches (same-SHA re-run)', async () => {
    const item = makeItem({ fingerprint: 'c' });
    const existing = { id: 5, body: renderFindingComment(item), user: BOT_USER };
    const { client, spies } = makeClient({ commentPages: [[existing]] });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });

    expect(res).toEqual({ posted: 0, updated: 0, failed: [] });
    expect(spies.updateReviewComment).not.toHaveBeenCalled();
    expect(spies.createReview).not.toHaveBeenCalled();
  });

  it('ignores a human-planted finding marker and posts the finding as new', async () => {
    const item = makeItem({ fingerprint: 'd' });
    const humanPlant = {
      id: 9,
      body: `${findingMarker('d')}\nplanted by a human`,
      user: { login: 'attacker', type: 'User' },
    };
    const { client, spies } = makeClient({ commentPages: [[humanPlant]] });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });

    expect(spies.updateReviewComment).not.toHaveBeenCalled();
    expect(spies.createReview).toHaveBeenCalledOnce();
    expect(res.posted).toBe(1);
  });
});

describe('reconcileFindings — pending-review cleanup', () => {
  it('deletes ONLY the bot-owned PENDING review before posting', async () => {
    const item = makeItem();
    const reviews = [
      { id: 55, state: 'PENDING', user: BOT_USER },
      { id: 66, state: 'PENDING', user: { login: 'dev', type: 'User' } },
      { id: 77, state: 'COMMENTED', user: BOT_USER },
    ];
    const { client, spies } = makeClient({ reviews });
    await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });

    expect(spies.deletePendingReview).toHaveBeenCalledOnce();
    expect((spies.deletePendingReview.mock.calls[0][0] as { review_id: number }).review_id).toBe(55);
  });
});

describe('reconcileFindings — 422 failure ladder', () => {
  it('retries per-comment on a batch 422; good anchors post, bad ones return as failed', async () => {
    const good = makeItem({ fingerprint: 'g', path: 'src/g.ts', anchor: { startLine: 3, endLine: 3 } });
    const bad = makeItem({ fingerprint: 'x', path: 'src/x.ts', anchor: { startLine: 999, endLine: 999 } });
    const createImpl = vi.fn(
      async (params: { comments?: Array<{ path: string }> }) => {
        const comments = params.comments ?? [];
        if (comments.length > 1) {
          const e = new Error('Unprocessable Entity');
          (e as unknown as { status: number }).status = 422;
          throw e;
        }
        if (comments[0]?.path === 'src/x.ts') {
          const e = new Error('line not part of the diff');
          (e as unknown as { status: number }).status = 422;
          throw e;
        }
        return { data: { id: 1 } };
      },
    );
    const { client, spies } = makeClient({ createImpl });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [good, bad] });

    expect(res.posted).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].fingerprint).toBe('x');
    // one batch attempt + two per-comment retries
    expect(spies.createReview).toHaveBeenCalledTimes(3);
  });
});

describe('reconcileFindings — moved anchor (#8)', () => {
  it('re-creates (does NOT patch) a finding whose anchor moved to a new line', async () => {
    const item = makeItem({ fingerprint: 'm', path: 'src/foo.ts', anchor: { startLine: 42, endLine: 42 } });
    // Same fingerprint, but the existing comment sits on an OLD line — a PATCH
    // cannot move a review comment's anchor, so it must be re-created.
    const existing = {
      id: 900,
      body: `${findingMarker('m')}\nold`,
      user: BOT_USER,
      path: 'src/foo.ts',
      line: 10,
    };
    const { client, spies } = makeClient({ commentPages: [[existing]] });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });

    expect(spies.updateReviewComment).not.toHaveBeenCalled();
    expect(spies.createReview).toHaveBeenCalledOnce();
    const call = spies.createReview.mock.calls[0][0] as { comments: Array<{ line: number }> };
    expect(call.comments[0].line).toBe(42);
    expect(res).toEqual({ posted: 1, updated: 0, failed: [] });
  });

  it('PATCHes in place when path + line still match (anchor unchanged)', async () => {
    const item = makeItem({ fingerprint: 'k', path: 'src/foo.ts', anchor: { startLine: 10, endLine: 10 } });
    const existing = {
      id: 901,
      body: `${findingMarker('k')}\nstale body`,
      user: BOT_USER,
      path: 'src/foo.ts',
      line: 10,
    };
    const { client, spies } = makeClient({ commentPages: [[existing]] });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });

    expect(spies.updateReviewComment).toHaveBeenCalledOnce();
    expect(spies.createReview).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
  });

  it('uses original_line as the anchor fallback when line is null', async () => {
    const item = makeItem({ fingerprint: 'o', path: 'src/foo.ts', anchor: { startLine: 7, endLine: 7 } });
    const existing = {
      id: 902,
      body: `${findingMarker('o')}\nold`,
      user: BOT_USER,
      path: 'src/foo.ts',
      line: null,
      original_line: 99, // 99 !== 7 → moved → re-create
    };
    const { client, spies } = makeClient({ commentPages: [[existing]] });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    expect(spies.createReview).toHaveBeenCalledOnce();
    expect(spies.updateReviewComment).not.toHaveBeenCalled();
    expect(res.posted).toBe(1);
  });
});

describe('reconcileFindings — non-422 batch failure (#9)', () => {
  it('returns ALL items as failed with no per-comment retry on a 500', async () => {
    const a = makeItem({ fingerprint: 'a', path: 'src/a.ts', anchor: { startLine: 3, endLine: 3 } });
    const b = makeItem({ fingerprint: 'b', path: 'src/b.ts', anchor: { startLine: 4, endLine: 4 } });
    const createImpl = vi.fn(async () => {
      const e = new Error('server error');
      (e as unknown as { status: number }).status = 500;
      throw e;
    });
    const { client, spies } = makeClient({ createImpl });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [a, b] });

    expect(res.posted).toBe(0);
    expect(res.failed).toHaveLength(2);
    // ONE batch attempt, NO per-comment retries (the batch may have partially applied).
    expect(spies.createReview).toHaveBeenCalledOnce();
  });

  it('detects the non-422 via response.status (axios shape) too', async () => {
    const a = makeItem({ fingerprint: 'a', path: 'src/a.ts', anchor: { startLine: 3, endLine: 3 } });
    const createImpl = vi.fn(async () => {
      const e = new Error('bad gateway');
      (e as unknown as { response: { status: number } }).response = { status: 502 };
      throw e;
    });
    const { client, spies } = makeClient({ createImpl });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [a] });
    expect(res.failed).toHaveLength(1);
    expect(spies.createReview).toHaveBeenCalledOnce();
  });
});

describe('reconcileFindings — authenticated actor (PAT) identity (#7 / #10)', () => {
  const asUser = (login: string) => async () => ({ data: { login } });

  it('#7: reconciles its OWN prior finding comment authored by a user-PAT (exact login)', async () => {
    const item = makeItem({ fingerprint: 'p' });
    // Authored as a user (type 'User'), not a [bot]; only the exact-login match
    // recognises it, so the stale body is PATCHed instead of duplicated.
    const existing = { id: 12, body: `${findingMarker('p')}\nstale`, user: { login: 'pat-owner', type: 'User' } };
    const { client, spies } = makeClient({
      commentPages: [[existing]],
      getAuthenticated: asUser('pat-owner'),
    });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    expect(spies.updateReviewComment).toHaveBeenCalledOnce();
    expect(spies.createReview).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
  });

  it('#10: does NOT delete another bot’s PENDING review when the actor is a known PAT', async () => {
    const item = makeItem();
    const reviews = [{ id: 55, state: 'PENDING', user: BOT_USER }];
    const { client, spies } = makeClient({ reviews, getAuthenticated: asUser('pat-owner') });
    await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    expect(spies.deletePendingReview).not.toHaveBeenCalled();
  });

  it('deletes its OWN pending review when the actor PAT matches the review author', async () => {
    const item = makeItem();
    const reviews = [{ id: 56, state: 'PENDING', user: { login: 'pat-owner', type: 'User' } }];
    const { client, spies } = makeClient({ reviews, getAuthenticated: asUser('pat-owner') });
    await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    expect(spies.deletePendingReview).toHaveBeenCalledOnce();
    expect((spies.deletePendingReview.mock.calls[0][0] as { review_id: number }).review_id).toBe(56);
  });

  it('falls back to the bot heuristic when getAuthenticated fails', async () => {
    const item = makeItem();
    const reviews = [{ id: 77, state: 'PENDING', user: BOT_USER }];
    const { client, spies } = makeClient({
      reviews,
      getAuthenticated: async () => {
        throw new Error('403');
      },
    });
    await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    // Unknown actor → bot heuristic → the github-actions[bot] pending review IS deleted.
    expect(spies.deletePendingReview).toHaveBeenCalledOnce();
  });
});

describe('reconcileFindings — resilience (never throws)', () => {
  it('degrades all findings to failed when scanning review comments throws', async () => {
    const item = makeItem();
    const { client, spies } = makeClient();
    spies.iterator.mockImplementation(async function* () {
      throw new Error('list boom');
    });
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    expect(res.posted).toBe(0);
    expect(res.failed).toEqual([item]);
    expect(spies.createReview).not.toHaveBeenCalled();
  });

  it('swallows a listReviews failure during pending cleanup and still posts', async () => {
    const item = makeItem();
    const { client, spies } = makeClient();
    spies.listReviews.mockRejectedValue(new Error('reviews boom'));
    const res = await reconcileFindings({ client, ...REPO, analyzedSha: 'sha', items: [item] });
    expect(res.posted).toBe(1);
  });
});
