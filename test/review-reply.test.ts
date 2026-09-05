import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleReviewReply,
  type ReviewReplyClient,
  type ReviewReplyHub,
} from '../src/review-reply';

const OWNER = 'acme';
const REPO = 'widget';
const PR = 42;
const ROOT_ID = 900;
const TRIGGER_ID = 901;
const HEAD = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const REPO_ID = '123e4567-e89b-12d3-a456-426614174000';

const trigger = {
  id: TRIGGER_ID,
  body: 'Does this caller still depend on the old contract?',
  in_reply_to_id: ROOT_ID,
  user: { login: 'reviewer', type: 'User' },
};

const root = {
  id: ROOT_ID,
  body: `<!-- gitnexus-finding:v1:${FINGERPRINT} -->\n\nFinding`,
  in_reply_to_id: null,
  pull_request_url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR}`,
  user: { login: 'github-actions[bot]', type: 'Bot' },
};

const answer = {
  schemaVersion: '1' as const,
  fingerprint: FINGERPRINT,
  analyzedSha: HEAD,
  verdict: 'supported' as const,
  reply: 'The current graph evidence supports the finding.',
  evidence: [{ path: 'src/index.ts', startLine: 10, kind: 'anchor' as const }],
};

function asyncPages(pagesForCall: () => Array<Array<Record<string, unknown>>>) {
  return async function* () {
    for (const data of pagesForCall()) yield { data };
  };
}

function makeHarness(opts?: {
  authenticatedLogin?: string | null;
  root?: Record<string, unknown>;
  scanPages?: Array<Array<Record<string, unknown>>>[];
  heads?: string[];
  answer?: unknown;
}) {
  let scan = 0;
  const scanPages = opts?.scanPages ?? [[[]], [[]]];
  const heads = [...(opts?.heads ?? [HEAD, HEAD])];
  const request = vi.fn().mockResolvedValue({ data: { id: 902 } });
  const client: ReviewReplyClient = {
    paginate: {
      iterator: vi.fn(
        asyncPages(() => scanPages[Math.min(scan++, scanPages.length - 1)] ?? [[]]),
      ),
    },
    rest: {
      pulls: {
        get: vi.fn(async () => ({ data: { head: { sha: heads.shift() } } })),
        getReviewComment: vi.fn(async () => ({ data: opts?.root ?? root })),
      },
      users: {
        getAuthenticated: vi.fn(async () => {
          if (opts?.authenticatedLogin === null) throw new Error('identity unavailable');
          return { data: { login: opts?.authenticatedLogin ?? 'actions-user' } };
        }),
      },
    },
    request,
  };
  const hub: ReviewReplyHub = {
    resolveRepoId: vi.fn().mockResolvedValue(REPO_ID),
    requestFindingReply: vi.fn().mockResolvedValue(opts?.answer ?? answer),
  };
  const warning = vi.fn();
  return { client, hub, request, warning };
}

async function run(harness: ReturnType<typeof makeHarness>, eventComment = trigger) {
  return handleReviewReply({
    client: harness.client,
    hub: harness.hub,
    hubUrl: 'https://hub.example.com',
    token: 'gnx_secret',
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    eventComment,
    warning: harness.warning,
  });
}

beforeEach(() => vi.clearAllMocks());

describe('handleReviewReply', () => {
  it('posts a validated answer to the top-level finding comment', async () => {
    const h = makeHarness({
      authenticatedLogin: 'actions-user',
      root: { ...root, user: { login: 'actions-user', type: 'User' } },
    });

    await expect(run(h)).resolves.toEqual({ action: 'posted' });
    expect(h.hub.requestFindingReply).toHaveBeenCalledWith({
      hubUrl: 'https://hub.example.com',
      token: 'gnx_secret',
      repoId: REPO_ID,
      prNumber: PR,
      fingerprint: FINGERPRINT,
      headSha: HEAD,
      question: trigger.body,
      triggerCommentId: TRIGGER_ID,
    });
    expect(h.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        pull_number: PR,
        comment_id: ROOT_ID,
        body: expect.stringContaining(
          '<!-- gitnexus-finding-reply:v1:901 -->',
        ),
      }),
    );
  });

  it('accepts only github-actions[bot] when authenticated identity is unavailable', async () => {
    const accepted = makeHarness({ authenticatedLogin: null });
    await expect(run(accepted)).resolves.toEqual({ action: 'posted' });

    const foreign = makeHarness({
      authenticatedLogin: null,
      root: { ...root, user: { login: 'dependabot[bot]', type: 'Bot' } },
    });
    await expect(run(foreign)).resolves.toEqual({ action: 'skipped' });
    expect(foreign.hub.requestFindingReply).not.toHaveBeenCalled();
  });

  it('rejects bot triggers, human-authored parents, and permissive fingerprints', async () => {
    const botTrigger = makeHarness({ authenticatedLogin: null });
    await expect(
      run(botTrigger, { ...trigger, user: { login: 'some-app[bot]', type: 'Bot' } }),
    ).resolves.toEqual({ action: 'skipped' });
    expect(botTrigger.client.rest.pulls.getReviewComment).not.toHaveBeenCalled();

    const humanParent = makeHarness({
      authenticatedLogin: null,
      root: { ...root, user: { login: 'attacker', type: 'User' } },
    });
    await expect(run(humanParent)).resolves.toEqual({ action: 'skipped' });

    const badFingerprint = makeHarness({
      authenticatedLogin: null,
      root: {
        ...root,
        body: '<!-- gitnexus-finding:v1:fp-123 -->',
      },
    });
    await expect(run(badFingerprint)).resolves.toEqual({ action: 'skipped' });
    expect(badFingerprint.hub.requestFindingReply).not.toHaveBeenCalled();
  });

  it('rejects an Action answer webhook authored as User by a github-token PAT', async () => {
    const h = makeHarness({
      authenticatedLogin: 'actions-user',
      root: { ...root, user: { login: 'actions-user', type: 'User' } },
    });
    const ownAnswer = {
      ...trigger,
      id: 902,
      body:
        '<!-- gitnexus-finding-reply:v1:901 -->\n\nThe current graph evidence supports the finding.',
      user: { login: 'actions-user', type: 'User' },
    };

    await expect(run(h, ownAnswer)).resolves.toEqual({ action: 'skipped' });
    expect(h.client.rest.pulls.getReviewComment).not.toHaveBeenCalled();
    expect(h.hub.requestFindingReply).not.toHaveBeenCalled();

    const genuineQuestion = { ...trigger, user: ownAnswer.user };
    await expect(run(makeHarness({
      authenticatedLogin: 'actions-user',
      root: { ...root, user: ownAnswer.user },
    }), genuineQuestion)).resolves.toEqual({ action: 'posted' });
  });

  it('rejects a reply/root outside the same top-level pull request', async () => {
    const nested = makeHarness({
      authenticatedLogin: null,
      root: { ...root, in_reply_to_id: 899 },
    });
    await expect(run(nested)).resolves.toEqual({ action: 'skipped' });

    const wrongPr = makeHarness({
      authenticatedLogin: null,
      root: { ...root, pull_request_url: `${root.pull_request_url}0` },
    });
    await expect(run(wrongPr)).resolves.toEqual({ action: 'skipped' });
    expect(wrongPr.hub.requestFindingReply).not.toHaveBeenCalled();
  });

  it('finds an owned duplicate marker on a later page before Hub work', async () => {
    const h = makeHarness({
      authenticatedLogin: null,
      scanPages: [
        [
          [{ id: 1, body: 'unrelated', user: root.user }],
          [
            {
              id: 2,
              body: '<!-- gitnexus-finding-reply:v1:901 -->',
              user: root.user,
            },
          ],
        ],
      ],
    });

    await expect(run(h)).resolves.toEqual({ action: 'skipped' });
    expect(h.hub.resolveRepoId).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('does not let a forged marker suppress an answer', async () => {
    const h = makeHarness({
      authenticatedLogin: null,
      scanPages: [
        [[{ id: 1, body: '<!-- gitnexus-finding-reply:v1:901 -->', user: trigger.user }]],
        [[]],
      ],
    });

    await expect(run(h)).resolves.toEqual({ action: 'posted' });
  });

  it('does not post when another run creates the marker during Hub work', async () => {
    const h = makeHarness({
      authenticatedLogin: null,
      scanPages: [
        [[]],
        [[{ id: 2, body: '<!-- gitnexus-finding-reply:v1:901 -->', user: root.user }]],
      ],
    });

    await expect(run(h)).resolves.toEqual({ action: 'skipped' });
    expect(h.hub.requestFindingReply).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
  });

  it('rejects stale or malformed Hub identity and a PR head that changes before posting', async () => {
    const stale = makeHarness({
      authenticatedLogin: null,
      answer: { ...answer, analyzedSha: 'c'.repeat(40) },
    });
    await expect(run(stale)).resolves.toEqual({ action: 'skipped' });
    expect(stale.request).not.toHaveBeenCalled();

    const changed = makeHarness({
      authenticatedLogin: null,
      heads: [HEAD, 'd'.repeat(40)],
    });
    await expect(run(changed)).resolves.toEqual({ action: 'skipped' });
    expect(changed.request).not.toHaveBeenCalled();
  });

  it('turns reply-path transport errors into a generic presentation-only warning', async () => {
    const h = makeHarness({ authenticatedLogin: null });
    vi.mocked(h.hub.requestFindingReply).mockRejectedValueOnce(
      new Error(`provider leaked ${trigger.body}`),
    );

    await expect(run(h)).resolves.toEqual({ action: 'skipped' });
    expect(h.warning).toHaveBeenCalledWith(
      'GitNexus finding reply skipped because a GitHub or Hub request failed.',
    );
    expect(h.warning.mock.calls.flat().join(' ')).not.toContain(trigger.body);
    expect(h.request).not.toHaveBeenCalled();
  });
});
