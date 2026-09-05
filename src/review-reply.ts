import * as github from '@actions/github';
import {
  isFindingReplyResultFor,
  requestFindingReply,
  resolveRepoId,
} from './hub-client';
import { resolveActorLogin, type AuthenticatedActorClient } from './post-comment';
import { findingFingerprintFromBody } from './render-findings';
import {
  renderFindingReply,
  reviewReplyMarker,
  startsWithReviewReplyMarker,
} from './render-reply';

const FINGERPRINT_RE = /^[0-9a-f]{64}(?:-(?:[2-9]|[1-9][0-9]+))?$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MAX_QUESTION_CHARS = 4_000;
const PER_PAGE = 100;
const LIST_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments' as const;
const REPLY_ROUTE =
  'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies' as const;

type CommentUser = { login?: string; type?: string } | null;

type ReviewCommentRecord = {
  id?: number;
  body?: string;
  in_reply_to_id?: number | null;
  pull_request_url?: string;
  user?: CommentUser;
};

export interface ReviewReplyClient extends AuthenticatedActorClient {
  paginate: {
    iterator: (
      route: typeof LIST_ROUTE,
      params: { owner: string; repo: string; pull_number: number; per_page: number },
    ) => AsyncIterable<{ data: ReviewCommentRecord[] }>;
  };
  rest: {
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{ data: { head?: { sha?: unknown } } }>;
      getReviewComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
      }) => Promise<{ data: ReviewCommentRecord }>;
    };
    users: AuthenticatedActorClient['rest']['users'];
  };
  request: (
    route: typeof REPLY_ROUTE,
    params: {
      owner: string;
      repo: string;
      pull_number: number;
      comment_id: number;
      body: string;
    },
  ) => Promise<unknown>;
}

export interface ReviewReplyHub {
  resolveRepoId: typeof resolveRepoId;
  requestFindingReply: typeof requestFindingReply;
}

const defaultHub: ReviewReplyHub = { resolveRepoId, requestFindingReply };

/**
 * Answer an eligible human reply to an Action-owned inline finding. This is a
 * presentation-only path: every transport failure is reduced to a fixed warning
 * and no raw body, provider output, prompt, or token is logged.
 */
export async function handleReviewReply(opts: {
  client: ReviewReplyClient;
  hub?: ReviewReplyHub;
  hubUrl: string;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  eventComment: unknown;
  warning: (message: string) => void;
}): Promise<{ action: 'posted' | 'skipped' }> {
  const trigger = validateTrigger(opts);
  if (!trigger) return { action: 'skipped' };

  try {
    const parentResponse = await opts.client.rest.pulls.getReviewComment({
      owner: opts.owner,
      repo: opts.repo,
      comment_id: trigger.parentId,
    });
    const parent = parentResponse.data;
    if (!isEligibleParent(parent, opts, trigger.parentId)) return { action: 'skipped' };

    const fingerprint = findingFingerprintFromBody(parent.body as string);
    if (fingerprint === null || !FINGERPRINT_RE.test(fingerprint)) {
      return { action: 'skipped' };
    }

    const actorLogin = await resolveActorLogin(opts.client);
    if (!isStrictlyOwned(parent.user, actorLogin)) return { action: 'skipped' };

    const marker = reviewReplyMarker(trigger.id);
    if (await hasOwnedMarker(opts.client, opts, marker, actorLogin)) {
      return { action: 'skipped' };
    }

    const headSha = await currentHeadSha(opts.client, opts);
    if (!headSha) return { action: 'skipped' };

    const hub = opts.hub ?? defaultHub;
    const repoId = await hub.resolveRepoId({
      hubUrl: opts.hubUrl,
      token: opts.token,
      fullName: `${opts.owner}/${opts.repo}`,
    });
    const answer = await hub.requestFindingReply({
      hubUrl: opts.hubUrl,
      token: opts.token,
      repoId,
      prNumber: opts.prNumber,
      fingerprint,
      headSha,
      question: trigger.question,
      triggerCommentId: trigger.id,
    });
    if (!isFindingReplyResultFor(answer, { fingerprint, analyzedSha: headSha })) {
      return { action: 'skipped' };
    }

    if (await hasOwnedMarker(opts.client, opts, marker, actorLogin)) {
      return { action: 'skipped' };
    }
    const latestHeadSha = await currentHeadSha(opts.client, opts);
    if (latestHeadSha !== headSha) return { action: 'skipped' };

    await opts.client.request(REPLY_ROUTE, {
      owner: opts.owner,
      repo: opts.repo,
      pull_number: opts.prNumber,
      comment_id: trigger.parentId,
      body: renderFindingReply({ triggerCommentId: trigger.id, reply: answer.reply }),
    });
    return { action: 'posted' };
  } catch {
    opts.warning('GitNexus finding reply skipped because a GitHub or Hub request failed.');
    return { action: 'skipped' };
  }
}

function validateTrigger(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  eventComment: unknown;
}): { id: number; parentId: number; question: string } | null {
  if (
    !/^[\w.-]+$/.test(opts.owner) ||
    !/^[\w.-]+$/.test(opts.repo) ||
    !Number.isSafeInteger(opts.prNumber) ||
    opts.prNumber <= 0 ||
    !isRecord(opts.eventComment)
  ) {
    return null;
  }
  const comment = opts.eventComment;
  const question = typeof comment.body === 'string' ? comment.body.trim() : '';
  if (
    !Number.isSafeInteger(comment.id) ||
    Number(comment.id) <= 0 ||
    !Number.isSafeInteger(comment.in_reply_to_id) ||
    Number(comment.in_reply_to_id) <= 0 ||
    !isRecord(comment.user) ||
    comment.user.type !== 'User' ||
    !question ||
    question.length > MAX_QUESTION_CHARS ||
    startsWithReviewReplyMarker(question)
  ) {
    return null;
  }
  return { id: Number(comment.id), parentId: Number(comment.in_reply_to_id), question };
}

function isEligibleParent(
  parent: ReviewCommentRecord,
  opts: { owner: string; repo: string; prNumber: number },
  parentId: number,
): boolean {
  return (
    parent.id === parentId &&
    parent.in_reply_to_id == null &&
    typeof parent.body === 'string' &&
    samePullRequest(parent.pull_request_url, opts)
  );
}

function samePullRequest(
  rawUrl: unknown,
  opts: { owner: string; repo: string; prNumber: number },
): boolean {
  if (typeof rawUrl !== 'string') return false;
  try {
    const path = new URL(rawUrl).pathname.replace(/\/+$/, '').toLowerCase();
    return path === `/repos/${opts.owner}/${opts.repo}/pulls/${opts.prNumber}`.toLowerCase();
  } catch {
    return false;
  }
}

function isStrictlyOwned(user: CommentUser | undefined, actorLogin: string | null): boolean {
  if (actorLogin !== null) return user?.login === actorLogin;
  return user?.type === 'Bot' && user.login === 'github-actions[bot]';
}

async function hasOwnedMarker(
  client: ReviewReplyClient,
  opts: { owner: string; repo: string; prNumber: number },
  marker: string,
  actorLogin: string | null,
): Promise<boolean> {
  for await (const page of client.paginate.iterator(LIST_ROUTE, {
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.prNumber,
    per_page: PER_PAGE,
  })) {
    for (const comment of page.data) {
      if (
        typeof comment.body === 'string' &&
        comment.body.includes(marker) &&
        isStrictlyOwned(comment.user, actorLogin)
      ) {
        return true;
      }
    }
  }
  return false;
}

async function currentHeadSha(
  client: ReviewReplyClient,
  opts: { owner: string; repo: string; prNumber: number },
): Promise<string | null> {
  const res = await client.rest.pulls.get({
    owner: opts.owner,
    repo: opts.repo,
    pull_number: opts.prNumber,
  });
  const sha = res.data.head?.sha;
  return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Narrow a full Octokit instance to the reply path's reviewed surface. */
export function asReviewReplyClient(
  octokit: ReturnType<typeof github.getOctokit>,
): ReviewReplyClient {
  return {
    paginate: {
      iterator: (route, params) => octokit.paginate.iterator(route, params),
    },
    rest: {
      pulls: {
        get: (params) => octokit.rest.pulls.get(params),
        getReviewComment: (params) => octokit.rest.pulls.getReviewComment(params),
      },
      users: {
        getAuthenticated: () => octokit.rest.users.getAuthenticated(),
      },
    },
    request: (route, params) => octokit.request(route, params),
  };
}
