import { describe, it, expect, vi } from 'vitest';
import { reconcileFindings, type ReviewClient } from '../src/post-review';
import { findingMarker, renderFindingComment } from '../src/render-findings';
import type { FindingItem } from '../src/types/blast-result';

// GitHub-set, unforgeable author identity. type: 'Bot' + '[bot]' login is what
// lets the reconciler tell its own comment from a human-planted marker.
const BOT_USER = { login: 'github-actions[bot]', type: 'Bot' };

type MockComment = { id: number; body?: string; user?: { login?: string; type?: string } | null };
type MockReview = { id: number; state?: string; user?: { login?: string; type?: string } | null };

interface MockOpts {
  commentPages?: MockComment[][];
  reviews?: MockReview[];
  createImpl?: (params: {
    comments?: Array<{ path: string; line: number; side: string; body: string }>;
  }) => Promise<{ data: { id: number } }>;
  createId?: number;
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
    },
  };
  return { client, spies: { iterator, listReviews, createReview, updateReviewComment, deletePendingReview } };
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
