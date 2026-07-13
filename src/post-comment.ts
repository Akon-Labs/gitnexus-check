/**
 * @brief: Octokit upsert for the PR comment carrying the v1 marker. We
 *         paginate the issue-comments list, substring-match the marker,
 *         and either PATCH the existing comment body or POST a new one.
 *         Token handling: the GITHUB_TOKEN flows through `@actions/github`
 *         via getOctokit and is never read, logged, or formatted here.
 *         A comment is only adopted (PATCHed) when its author is a bot, so a
 *         human commenter cannot plant the public marker to hijack or suppress
 *         our comment slot (see isAdoptableBotComment).
 */

import * as github from '@actions/github';

/**
 * @brief: The subset of an issue comment we read when scanning for our marker.
 *         `user` carries the author identity GitHub sets (never client-supplied)
 *         so we can tell our own bot comment from a human-planted lookalike.
 */
type ScannedComment = {
  id: number;
  body?: string;
  user?: { login?: string; type?: string } | null;
};

/**
 * @brief: GitHub REST client surface area we depend on. We narrow Octokit
 *         to just the four endpoints we need so the unit tests can pass a
 *         hand-rolled mock without satisfying the full Octokit interface.
 */
export interface IssueCommentsClient {
  paginate: {
    iterator: (
      route: 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      params: { owner: string; repo: string; issue_number: number; per_page: number },
    ) => AsyncIterable<{ data: Array<ScannedComment> }>;
  };
  rest: {
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<{ data: { id: number } }>;
      updateComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<{ data: { id: number } }>;
    };
  };
}

/** Outcome metadata for `main.ts` to set step outputs. */
export interface PostCommentResult {
  commentId: number;
  action: 'created' | 'updated';
}

/** Cap on pages we'll scan before giving up and creating a new comment. */
const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * @brief: Idempotently post-or-update the PR comment identified by
 *         `marker`. The marker must appear verbatim in the comment body
 *         (typically as the first line). On finding a match we PATCH;
 *         otherwise we POST a new one. Pagination terminates after
 *         MAX_PAGES (1,000 comments) and falls through to creation —
 *         realistically PRs do not have 1,000+ comments and the cap
 *         protects against runaway loops on a degenerate repo.
 *
 * @params: (opts.client: IssueCommentsClient) -> Narrowed Octokit instance.
 * @params: (opts.owner: string)               -> Repo owner login.
 * @params: (opts.repo: string)                -> Repo name.
 * @params: (opts.prNumber: number)            -> PR number (issue_number to GitHub).
 * @params: (opts.marker: string)              -> Comment-identifying marker substring.
 * @params: (opts.body: string)                -> Full rendered comment body.
 *
 * @returns: PostCommentResult — comment id and whether we created or updated.
 * @call-routes: GET /repos/:owner/:repo/issues/:issue_number/comments (paginated)
 * @call-routes: POST /repos/:owner/:repo/issues/:issue_number/comments
 * @call-routes: PATCH /repos/:owner/:repo/issues/comments/:comment_id
 */
export async function postOrUpdateComment(opts: {
  client: IssueCommentsClient;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  body: string;
}): Promise<PostCommentResult> {
  validateInputs(opts);
  const existingId = await findExistingCommentId(opts);
  if (existingId !== null) {
    const res = await opts.client.rest.issues.updateComment({
      owner: opts.owner,
      repo: opts.repo,
      comment_id: existingId,
      body: opts.body,
    });
    return { commentId: res.data.id, action: 'updated' };
  }
  const res = await opts.client.rest.issues.createComment({
    owner: opts.owner,
    repo: opts.repo,
    issue_number: opts.prNumber,
    body: opts.body,
  });
  return { commentId: res.data.id, action: 'created' };
}

/**
 * @brief: Page through the PR's issue comments and return the id of the first
 *         comment we may safely adopt: one whose body contains `marker` AND
 *         whose author is a bot (see isAdoptableBotComment). A marker planted by
 *         a human is ignored so a commenter cannot hijack or suppress our
 *         comment slot. Returns null if none is found within MAX_PAGES — the
 *         caller then creates a fresh comment.
 */
async function findExistingCommentId(opts: {
  client: IssueCommentsClient;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
}): Promise<number | null> {
  const iterator = opts.client.paginate.iterator(
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
    {
      owner: opts.owner,
      repo: opts.repo,
      issue_number: opts.prNumber,
      per_page: PER_PAGE,
    },
  );
  let pages = 0;
  for await (const page of iterator) {
    pages += 1;
    for (const comment of page.data) {
      if (isAdoptableBotComment(comment, opts.marker)) {
        return comment.id;
      }
    }
    if (pages >= MAX_PAGES) return null;
  }
  return null;
}

/**
 * @brief: True when `comment` is our own marker comment and therefore safe to
 *         adopt (PATCH). Requires BOTH the marker substring AND a bot author.
 *         A comment's `user.type` is set by GitHub and cannot be forged, so
 *         gating on `type === 'Bot'` stops a human commenter from planting the
 *         public marker to hijack (or suppress) our comment slot — a human's
 *         type is `'User'`, so their planted marker is ignored and a fresh
 *         comment is created. The login is matched by the `[bot]` suffix rather
 *         than a fixed `github-actions[bot]` so a run configured with a GitHub
 *         App installation token (author `<app>[bot]`) still updates its own
 *         comment instead of duplicating it every run.
 *
 * @params: (comment: ScannedComment) -> A comment from the paginated listing.
 * @params: (marker: string)          -> The identifying marker substring.
 *
 * @returns: boolean — true iff the comment is a bot-authored marker comment.
 */
function isAdoptableBotComment(comment: ScannedComment, marker: string): boolean {
  if (typeof comment.body !== 'string' || !comment.body.includes(marker)) return false;
  return isBotAuthor(comment.user);
}

/**
 * @brief: True when a comment's author is a bot we may safely adopt. A comment's
 *         `user.type` is set by GitHub and cannot be forged, so gating on
 *         `type === 'Bot'` stops a human commenter from planting one of our
 *         public markers to hijack (or suppress) a comment slot — a human's type
 *         is `'User'`. The login is matched by the `[bot]` suffix rather than a
 *         fixed `github-actions[bot]` so a run configured with a GitHub App
 *         installation token (author `<app>[bot]`) still adopts its own comment.
 *
 *         Exported so the review-comment reconciler (post-review.ts) applies the
 *         IDENTICAL bot-identity semantics when scanning review comments for our
 *         finding markers — one predicate, no drift.
 *
 * @params: (user) -> The GitHub-set author identity off a comment.
 * @returns: boolean — true iff the author is a `[bot]`-suffixed Bot.
 */
export function isBotAuthor(user: { login?: string; type?: string } | null | undefined): boolean {
  return (
    user?.type === 'Bot' && typeof user.login === 'string' && user.login.endsWith('[bot]')
  );
}

function validateInputs(opts: {
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  body: string;
}): void {
  if (!/^[\w.-]+$/.test(opts.owner)) {
    throw new Error(`invalid owner: ${opts.owner}`);
  }
  if (!/^[\w.-]+$/.test(opts.repo)) {
    throw new Error(`invalid repo: ${opts.repo}`);
  }
  if (!Number.isInteger(opts.prNumber) || opts.prNumber <= 0) {
    throw new Error(`invalid prNumber: ${String(opts.prNumber)}`);
  }
  if (!opts.marker) throw new Error('marker must be non-empty');
  if (!opts.body) throw new Error('body must be non-empty');
  if (!opts.body.includes(opts.marker)) {
    throw new Error('body must contain marker — refusing to post unrecognisable comment');
  }
}

/**
 * @brief: Adapt a full Octokit instance (from `github.getOctokit`) into
 *         the narrowed IssueCommentsClient shape. This indirection is
 *         purely a type-safety boundary so `main.ts` is the only file
 *         touching the broader Octokit surface; the comment poster
 *         stays test-friendly with a hand-rolled mock.
 *
 * @params: (octokit: ReturnType<typeof github.getOctokit>) -> Auth'd Octokit.
 *
 * @returns: IssueCommentsClient — narrowed client for the poster to use.
 */
export function asIssueCommentsClient(
  octokit: ReturnType<typeof github.getOctokit>,
): IssueCommentsClient {
  return {
    paginate: {
      iterator: (route, params) => octokit.paginate.iterator(route, params),
    },
    rest: {
      issues: {
        createComment: (params) => octokit.rest.issues.createComment(params),
        updateComment: (params) => octokit.rest.issues.updateComment(params),
      },
    },
  };
}
