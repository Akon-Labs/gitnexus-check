/**
 * Orchestration test for src/main.ts. We mock @actions/core,
 * @actions/github, the hub-client module, and post-comment module so the
 * test asserts wiring (sequence, output-setting, setFailed-on-error) and
 * does not perform any I/O.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const outputs: Record<string, string> = {};
const inputs: Record<string, string> = {};
const setFailedSpy = vi.fn();
const warningSpy = vi.fn();
const errorSpy = vi.fn();
const infoSpy = vi.fn();

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string, opts?: { required?: boolean }) => {
    const v = inputs[name] ?? '';
    if (opts?.required && !v) throw new Error(`Input required: ${name}`);
    return v;
  }),
  setOutput: vi.fn((name: string, value: string) => {
    outputs[name] = value;
  }),
  setFailed: setFailedSpy,
  info: infoSpy,
  warning: warningSpy,
  error: errorSpy,
}));

const ghContext = {
  eventName: 'pull_request',
  payload: {
    // Absent by default (same-repo PR). Fork tests set repository + head.repo to
    // exercise the fork precheck; beforeEach resets both.
    repository: undefined as { full_name?: string } | undefined,
    pull_request: {
      number: 152,
      // Draft flag exercised by the Wave-2 gated draft-skip tests; reset each run.
      draft: undefined as boolean | undefined,
      head: { sha: undefined as unknown } as {
        sha: unknown;
        repo?: { full_name?: string } | null;
      },
    },
  },
  repo: { owner: 'Akon-Labs', repo: 'gitnexus-enterprise' },
};

const updateCommentSpy = vi.fn();
const getOctokitSpy = vi.fn(() => ({
  paginate: { iterator: vi.fn() },
  rest: {
    issues: {
      createComment: vi.fn(),
      updateComment: updateCommentSpy,
    },
  },
}));

vi.mock('@actions/github', () => ({
  context: ghContext,
  getOctokit: getOctokitSpy,
}));

const resolveSpy = vi.fn();
const refreshSpy = vi.fn();
const getBlastSpy = vi.fn();

vi.mock('../src/hub-client', async () => {
  const real = await vi.importActual<typeof import('../src/hub-client')>('../src/hub-client');
  return {
    ...real,
    resolveRepoId: (...args: unknown[]) => resolveSpy(...args),
    refreshBlast: (...args: unknown[]) => refreshSpy(...args),
    getBlast: (...args: unknown[]) => getBlastSpy(...args),
  };
});

const postSpy = vi.fn();
vi.mock('../src/post-comment', async () => {
  const real = await vi.importActual<typeof import('../src/post-comment')>(
    '../src/post-comment',
  );
  return {
    ...real,
    postOrUpdateComment: (...args: unknown[]) => postSpy(...args),
    asIssueCommentsClient: vi.fn(() => ({})),
  };
});

const reconcileSpy = vi.fn();
vi.mock('../src/post-review', async () => {
  const real = await vi.importActual<typeof import('../src/post-review')>('../src/post-review');
  return {
    ...real,
    reconcileFindings: (...args: unknown[]) => reconcileSpy(...args),
    asReviewClient: vi.fn(() => ({})),
  };
});

const parseThresholdSpy = vi.fn();
const evaluateGateSpy = vi.fn();
vi.mock('../src/gate', async () => {
  const real = await vi.importActual<typeof import('../src/gate')>('../src/gate');
  return {
    ...real,
    parseThreshold: (...args: unknown[]) => parseThresholdSpy(...args),
    evaluateGate: (...args: unknown[]) => evaluateGateSpy(...args),
  };
});

function loadFullBlast(): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'blast-result-full.json'), 'utf8'),
  );
}

// A read-only-token 403 on a comment write — the expected fork / restricted-token
// failure the Action degrades from (log-only) rather than failing the run.
const FORBIDDEN_403 = {
  isAxiosError: true,
  response: { status: 403, statusText: '', headers: {} },
  config: { url: 'https://api.github.com/repos/a/b/issues/1/comments' },
};

beforeEach(() => {
  for (const k of Object.keys(outputs)) delete outputs[k];
  for (const k of Object.keys(inputs)) delete inputs[k];
  inputs['hub-url'] = 'https://hub.example.com';
  inputs['token'] = 'gnx_test';
  inputs['github-token'] = 'ghp_test';
  ghContext.eventName = 'pull_request';
  ghContext.payload.repository = undefined;
  ghContext.payload.pull_request.number = 152;
  ghContext.payload.pull_request.draft = undefined;
  ghContext.payload.pull_request.head = { sha: undefined };
  setFailedSpy.mockReset();
  warningSpy.mockReset();
  errorSpy.mockReset();
  infoSpy.mockReset();
  resolveSpy.mockReset();
  refreshSpy.mockReset();
  getBlastSpy.mockReset();
  postSpy.mockReset();
  updateCommentSpy.mockReset();
  parseThresholdSpy.mockReset();
  evaluateGateSpy.mockReset();
  reconcileSpy.mockReset();
  reconcileSpy.mockResolvedValue({ posted: 0, updated: 0, failed: [] });
  // Default: advisory gate (empty input → null threshold → neutral).
  parseThresholdSpy.mockReturnValue(null);
  evaluateGateSpy.mockReturnValue('neutral');
  vi.resetModules();
});

describe('main — happy path', () => {
  it('resolves, refreshes, fetches, renders, posts; sets outputs', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import(
      '../src/types/blast-result'
    );
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    postSpy.mockResolvedValue({ commentId: 5555, action: 'created' });

    const { main } = await import('../src/main');
    await main();

    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(getBlastSpy).toHaveBeenCalledOnce();
    expect(postSpy).toHaveBeenCalledOnce();
    expect(outputs['comment-id']).toBe('5555');
    expect(outputs['blast-level']).toBe('LOW');
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('splices the Hub aiSummary into the posted body when present', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast() as Record<string, unknown>;
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw);
    blast.aiSummary = '## Summary\n\n🟢 LOW — nothing scary here.';
    getBlastSpy.mockResolvedValue(blast);
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });

    const { main } = await import('../src/main');
    await main();

    const body = (postSpy.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain('## Summary');
    expect(body).toContain('🟢 LOW — nothing scary here.');
  });

  it('posts the deterministic body unchanged when aiSummary is absent', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw)); // no aiSummary
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });

    const { main } = await import('../src/main');
    await main();

    const body = (postSpy.mock.calls[0][0] as { body: string }).body;
    expect(body).not.toContain('## Summary');
    expect(body).not.toContain('📋 Full report');
  });

  it('posts the raw rendered body (compose not invoked) when neither aiSummary nor sinceLastCommit is present', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw); // no aiSummary, no sinceLastCommit
    getBlastSpy.mockResolvedValue(blast);
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });

    // Compute the raw rendered comment the same way main does, to assert equality.
    const { renderComment } = await import('../src/render-comment');
    const expected = renderComment(blast, { prNumber: 152, hubUrl: 'https://hub.example.com' });

    const { main } = await import('../src/main');
    await main();

    const body = (postSpy.mock.calls[0][0] as { body: string }).body;
    expect(body).toBe(expected);
    expect(body).not.toContain('## Commit `');
  });

  it('posts a SEPARATE per-SHA comment for the since-last-commit delta; main comment carries no delta', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw);
    const headSha = 'a1b2c3d4e5f6a1b2c3d4';
    blast.sinceLastCommit = { headSha, summary: 'reworked the parser' };
    getBlastSpy.mockResolvedValue(blast);
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });

    const { main } = await import('../src/main');
    const { sinceCommitMarker } = await import('../src/slm-format');
    await main();

    // Two posts: [0] main comment under v1 marker, [1] standalone per-SHA comment.
    expect(postSpy).toHaveBeenCalledTimes(2);

    const mainCall = postSpy.mock.calls[0][0] as { marker: string; body: string };
    expect(mainCall.marker).toBe('<!-- gitnexus-review-v1 -->');
    expect(mainCall.body).not.toContain('## Commit `');
    expect(mainCall.body).not.toContain('gitnexus-since-commit');

    const sinceCall = postSpy.mock.calls[1][0] as { marker: string; body: string };
    expect(sinceCall.marker).toBe(sinceCommitMarker(headSha));
    expect(sinceCall.body).toContain(sinceCommitMarker(headSha));
    expect(sinceCall.body).toContain('## Commit `a1b2c3d` summary');
    expect(sinceCall.body).toContain('reworked the parser');

    // comment-id output stays the MAIN comment id.
    expect(outputs['comment-id']).toBe('1');
  });

  it('does not post a second comment when sinceLastCommit is absent', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw); // no sinceLastCommit
    getBlastSpy.mockResolvedValue(blast);
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });

    const { main } = await import('../src/main');
    await main();

    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('a thrown secondary-comment post does NOT fail the run; gate/outputs unaffected', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw);
    blast.sinceLastCommit = { headSha: 'a1b2c3d4e5f6a1b2c3d4', summary: 'reworked the parser' };
    getBlastSpy.mockResolvedValue(blast);
    // First call (main comment) succeeds; second call (since-commit) throws.
    postSpy
      .mockResolvedValueOnce({ commentId: 4242, action: 'created' })
      .mockRejectedValueOnce(new Error('secondary boom'));

    const { main } = await import('../src/main');
    await main();

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(setFailedSpy).not.toHaveBeenCalled();
    // comment-id output remains the MAIN comment id.
    expect(outputs['comment-id']).toBe('4242');
    expect(outputs['gate-decision']).toBe('neutral');
  });
});

describe('main — non-PR event', () => {
  it('warns and exits cleanly without calling Hub', async () => {
    ghContext.eventName = 'push';
    const { main } = await import('../src/main');
    await main();
    expect(warningSpy).toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(setFailedSpy).not.toHaveBeenCalled();
  });
});

describe('main — Hub error path', () => {
  it('calls setFailed with classified message when resolveRepoId throws', async () => {
    resolveSpy.mockRejectedValue(new Error('repo a/b not registered on Hub'));
    const { main } = await import('../src/main');
    await main();
    expect(setFailedSpy).toHaveBeenCalledOnce();
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('resolveRepoId');
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('classifies axios 401 from Hub correctly', async () => {
    const err = {
      isAxiosError: true,
      response: { status: 401, statusText: '', headers: {} },
      config: { url: 'https://hub.example.com/api/repos' },
    };
    resolveSpy.mockRejectedValue(err);
    const { main } = await import('../src/main');
    await main();
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('GITNEXUS_TOKEN is invalid or revoked');
  });
});

describe('main — GitHub error path', () => {
  it('degrades a 403 on the main comment to a loud error annotation (does not fail the run)', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import(
      '../src/types/blast-result'
    );
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    const err = {
      isAxiosError: true,
      response: { status: 403, statusText: '', headers: {} },
      config: { url: 'https://api.github.com/repos/a/b/issues/1/comments' },
    };
    postSpy.mockRejectedValue(err);

    const { main } = await import('../src/main');
    await main();

    // Defense in depth: a same-repo 403 (e.g. a Dependabot read-only token) is a
    // loud error annotation, NOT a failure — the run continues to the gate so a
    // restricted-token PR still gets its gate decision, while a genuine
    // misconfiguration is surfaced prominently rather than as a missable warning.
    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toContain('missing pull-requests:write permission');
    expect(errors).toContain('pull-requests: write');
    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(outputs['blast-level']).toBe('LOW');
    expect(outputs['gate-decision']).toBe('neutral');
    // Nothing was posted, so no comment-id is emitted.
    expect(outputs['comment-id']).toBeUndefined();
  });

  it('points a failed gate to the action log after a recovered 403 leaves no comment', async () => {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import(
      '../src/types/blast-result'
    );
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    postSpy.mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, statusText: '', headers: {} },
      config: { url: 'https://api.github.com/repos/a/b/issues/1/comments' },
    });
    inputs['fail-on-blast-level'] = 'LOW';
    parseThresholdSpy.mockReturnValue('LOW');
    evaluateGateSpy.mockReturnValue('fail');

    const { main } = await import('../src/main');
    await main();

    expect(setFailedSpy).toHaveBeenCalledOnce();
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('See action log.');
    expect(msg).not.toContain('See PR comment.');
  });

  it('a non-403 comment error (500) degrades to log-only, NEVER fails the run', async () => {
    // Posting the comment is presentation; the Hub compute already succeeded and
    // the gate decides from blastLevel alone. A transient GitHub 500 must not
    // fail a below-threshold run (doctrine: comment errors never setFailed).
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    const err = {
      isAxiosError: true,
      response: { status: 500, statusText: '', headers: {} },
      config: { url: 'https://api.github.com/repos/a/b/issues/1/comments' },
    };
    postSpy.mockRejectedValue(err);

    const { main } = await import('../src/main');
    await main();
    expect(setFailedSpy).not.toHaveBeenCalled();
    // Surfaced as a loud (non-failing) error annotation, and the review is logged.
    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errors).toContain('Could not post the review comment');
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('<!-- gitnexus-review-v1 -->');
    // The gate still ran on the Hub data.
    expect(outputs['blast-level']).toBe('LOW');
  });
});

describe('main — gate', () => {
  async function setupHappy(): Promise<void> {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    postSpy.mockResolvedValue({ commentId: 5555, action: 'created' });
  }

  it('advisory default: neutral decision, no setFailed', async () => {
    await setupHappy();
    parseThresholdSpy.mockReturnValue(null);
    evaluateGateSpy.mockReturnValue('neutral');
    const { main } = await import('../src/main');
    await main();
    expect(outputs['gate-decision']).toBe('neutral');
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('pass: no setFailed and comment still posted', async () => {
    await setupHappy();
    inputs['fail-on-blast-level'] = 'CRITICAL';
    parseThresholdSpy.mockReturnValue('CRITICAL');
    evaluateGateSpy.mockReturnValue('pass');
    const { main } = await import('../src/main');
    await main();
    expect(outputs['gate-decision']).toBe('pass');
    expect(postSpy).toHaveBeenCalledOnce();
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('fail: setFailed called AFTER the comment is posted', async () => {
    await setupHappy();
    inputs['fail-on-blast-level'] = 'LOW';
    parseThresholdSpy.mockReturnValue('LOW');
    evaluateGateSpy.mockReturnValue('fail');
    let postCallOrder = -1;
    let failCallOrder = -1;
    let counter = 0;
    postSpy.mockImplementation(() => {
      postCallOrder = counter++;
      return Promise.resolve({ commentId: 5555, action: 'created' });
    });
    setFailedSpy.mockImplementation(() => {
      failCallOrder = counter++;
    });
    const { main } = await import('../src/main');
    await main();
    expect(outputs['gate-decision']).toBe('fail');
    expect(setFailedSpy).toHaveBeenCalledOnce();
    expect(postCallOrder).toBeGreaterThanOrEqual(0);
    expect(failCallOrder).toBeGreaterThan(postCallOrder);
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('See PR comment.');
  });

  it('invalid threshold: setFailed before any Hub call', async () => {
    inputs['fail-on-blast-level'] = 'bogus';
    parseThresholdSpy.mockImplementation(() => {
      throw new Error('fail-on-blast-level: invalid value "bogus" — expected LOW, MEDIUM, HIGH, or CRITICAL');
    });
    const { main } = await import('../src/main');
    await main();
    expect(setFailedSpy).toHaveBeenCalledOnce();
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('parseThreshold');
    expect(msg).toContain('invalid value');
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(getBlastSpy).not.toHaveBeenCalled();
  });
});

describe('main — fork PR (log-only mode)', () => {
  async function setupHappy(): Promise<void> {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    postSpy.mockResolvedValue({ commentId: 5555, action: 'created' });
  }

  function makeFork(): void {
    ghContext.payload.repository = { full_name: 'Akon-Labs/gitnexus-enterprise' };
    ghContext.payload.pull_request.head = {
      sha: undefined,
      repo: { full_name: 'attacker/gitnexus-enterprise' },
    };
  }

  it('ATTEMPTS the comment on a fork and, on a 403, logs the rendered review (log-only)', async () => {
    await setupHappy();
    makeFork();
    // A fork MAY carry write access (pull_request_target / write PAT), so we
    // attempt the write; the read-only 403 degrades to log-only.
    postSpy.mockRejectedValue(FORBIDDEN_403);
    const { main } = await import('../src/main');
    await main();

    expect(postSpy).toHaveBeenCalledOnce();
    // The rendered review is emitted into the step log so the analysis stays visible.
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('<!-- gitnexus-review-v1 -->');
    expect(logged.toLowerCase()).toContain('fork pr detected');
    expect(setFailedSpy).not.toHaveBeenCalled();
    // Hub calls ran exactly as for a same-repo PR.
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(getBlastSpy).toHaveBeenCalledOnce();
  });

  it('a fork with write access posts normally (no log-only fallback)', async () => {
    await setupHappy();
    makeFork();
    // postSpy resolves (setupHappy) → the fork's configured write token succeeds.
    const { main } = await import('../src/main');
    await main();

    expect(postSpy).toHaveBeenCalledOnce();
    expect(outputs['comment-id']).toBe('5555');
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged.toLowerCase()).not.toContain('fork pr detected');
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('a fork NEVER fails the run on a NON-403 error (500) — degrades to log-only', async () => {
    await setupHappy();
    makeFork();
    // A transient GitHub 500 on a fork's comment write must NOT block its gate
    // (the original fork-fails bug); only a same-repo non-403 fails fast.
    postSpy.mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, statusText: '', headers: {} },
      config: { url: 'https://api.github.com/repos/a/b/issues/1/comments' },
    });
    const { main } = await import('../src/main');
    await main();

    expect(setFailedSpy).not.toHaveBeenCalled();
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('<!-- gitnexus-review-v1 -->'); // report still in the log
    expect(logged.toLowerCase()).toContain('log-only mode');
  });

  it('still evaluates the gate after a fork 403; blast-level set, no comment-id, no failure', async () => {
    await setupHappy();
    makeFork();
    postSpy.mockRejectedValue(FORBIDDEN_403);
    const { main } = await import('../src/main');
    await main();

    expect(evaluateGateSpy).toHaveBeenCalledOnce();
    expect(outputs['blast-level']).toBe('LOW');
    expect(outputs['gate-decision']).toBe('neutral');
    expect(outputs['comment-id']).toBeUndefined();
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('the gate STILL fails the run on a fork 403 when the blast level trips the threshold', async () => {
    await setupHappy();
    makeFork();
    postSpy.mockRejectedValue(FORBIDDEN_403);
    inputs['fail-on-blast-level'] = 'LOW';
    parseThresholdSpy.mockReturnValue('LOW');
    evaluateGateSpy.mockReturnValue('fail');
    const { main } = await import('../src/main');
    await main();

    expect(outputs['gate-decision']).toBe('fail');
    expect(setFailedSpy).toHaveBeenCalledOnce();
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('meets or exceeds threshold');
    expect(msg).toContain('See action log.');
    expect(msg).not.toContain('See PR comment.');
  });

  it('detects a fork whose head repo was deleted (head.repo === null)', async () => {
    await setupHappy();
    ghContext.payload.repository = { full_name: 'Akon-Labs/gitnexus-enterprise' };
    ghContext.payload.pull_request.head = { sha: undefined, repo: null };
    postSpy.mockRejectedValue(FORBIDDEN_403);
    const { main } = await import('../src/main');
    await main();

    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged.toLowerCase()).toContain('fork pr detected');
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('ATTEMPTS the since-last-commit comment on a fork; a 403 degrades (no failure)', async () => {
    await setupHappy();
    makeFork();
    postSpy.mockRejectedValue(FORBIDDEN_403);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw);
    blast.sinceLastCommit = { headSha: 'a1b2c3d4e5f6a1b2c3d4', summary: 'reworked the parser' };
    getBlastSpy.mockResolvedValue(blast);
    const { main } = await import('../src/main');
    await main();

    // Both the main comment and the delta are attempted; both 403 and degrade.
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('a same-repo PR (head.repo.full_name === base) is NOT treated as a fork', async () => {
    await setupHappy();
    ghContext.payload.repository = { full_name: 'Akon-Labs/gitnexus-enterprise' };
    ghContext.payload.pull_request.head = {
      sha: undefined,
      repo: { full_name: 'Akon-Labs/gitnexus-enterprise' },
    };
    const { main } = await import('../src/main');
    await main();

    expect(postSpy).toHaveBeenCalledOnce();
  });
});

describe('main — head sha anchor (readHeadSha)', () => {
  async function setupHappy(): Promise<void> {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });
  }

  it('passes a valid head sha through to refreshBlast and getBlast', async () => {
    await setupHappy();
    ghContext.payload.pull_request.head = { sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' };
    const { main } = await import('../src/main');
    await main();
    expect((refreshSpy.mock.calls[0][0] as { headSha?: string }).headSha).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    );
    expect((getBlastSpy.mock.calls[0][0] as { headSha?: string }).headSha).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    );
  });

  it('degrades a malformed head sha to undefined (never throws)', async () => {
    await setupHappy();
    ghContext.payload.pull_request.head = { sha: 'not-a-real-sha!!' };
    const { main } = await import('../src/main');
    await main();
    expect((refreshSpy.mock.calls[0][0] as { headSha?: string }).headSha).toBeUndefined();
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it('degrades an absent head sha to undefined', async () => {
    await setupHappy();
    ghContext.payload.pull_request.head = { sha: undefined };
    const { main } = await import('../src/main');
    await main();
    expect((refreshSpy.mock.calls[0][0] as { headSha?: string }).headSha).toBeUndefined();
    expect((getBlastSpy.mock.calls[0][0] as { headSha?: string }).headSha).toBeUndefined();
  });
});

describe('main — token safety', () => {
  it('does not leak the GITNEXUS_TOKEN into any setFailed / warning / error call', async () => {
    inputs['token'] = 'gnx_secret_VERY_DO_NOT_LEAK';
    resolveSpy.mockRejectedValue(
      new Error('boom with token leak gnx_secret_VERY_DO_NOT_LEAK in message'),
    );
    const { main } = await import('../src/main');
    await main();
    const allCalls = [
      ...setFailedSpy.mock.calls,
      ...warningSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]
      .map((c) => c.map((x) => String(x)).join(' '))
      .join('\n');
    expect(allCalls).not.toContain('gnx_secret_VERY_DO_NOT_LEAK');
  });
});

describe('main — inline findings (Wave 2)', () => {
  const anchoredItem = {
    fingerprint: 'a1',
    checkId: 'chk',
    origin: 'deterministic',
    severity: 'error',
    confidence: 1,
    title: 'boom',
    rationale: 'why',
    path: 'src/a.ts',
    anchored: true,
    anchor: { startLine: 10, endLine: 10 },
  };
  const demotedItem = {
    fingerprint: 'd1',
    checkId: 'chk',
    origin: 'generated',
    severity: 'warning',
    confidence: 0.9,
    title: 'soft',
    rationale: 'demoted',
    path: 'src/b.ts',
    anchored: false,
  };

  async function setupBlast(findings?: unknown): Promise<void> {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw) as Record<string, unknown>;
    if (findings) blast.findings = findings;
    getBlastSpy.mockResolvedValue(blast);
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });
  }

  it('flag OFF: no reconcile, outputs are 0, only the main comment is posted', async () => {
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [anchoredItem],
      suppressedCount: 3, truncated: false, error: null,
    });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledOnce();
    expect(outputs['inline-findings-posted']).toBe('0');
    expect(outputs['inline-findings-suppressed']).toBe('0');
  });

  it('flag ON but findings are for a DIFFERENT head sha: skips inline posting (freshness guard)', async () => {
    inputs['inline-findings'] = 'true';
    // The run's head is 'b2b2b2b2'; the Hub findings envelope was computed for
    // the prior push 'a1a1a1a1' (async stage hasn't caught up). Posting A's
    // findings onto B would anchor to the wrong commit → skip.
    ghContext.payload.pull_request.head = { sha: 'b2b2b2b2' };
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'a1a1a1a1', items: [anchoredItem],
      suppressedCount: 0, truncated: false, error: null,
    });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(outputs['inline-findings-posted']).toBe('0');
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('not the current head');
  });

  it('flag ON and findings MATCH the head sha: posts normally', async () => {
    inputs['inline-findings'] = 'true';
    ghContext.payload.pull_request.head = { sha: 'abc1234' };
    reconcileSpy.mockResolvedValue({ posted: 1, updated: 0, failed: [] });
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'abc1234', items: [anchoredItem],
      suppressedCount: 0, truncated: false, error: null,
    });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).toHaveBeenCalledOnce();
    expect((reconcileSpy.mock.calls[0][0] as { analyzedSha: string }).analyzedSha).toBe('abc1234');
  });

  it('flag ON: reconciles anchored findings with analyzedSha; posted + Hub-suppressed outputs', async () => {
    inputs['inline-findings'] = 'true';
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha123', items: [anchoredItem],
      suppressedCount: 2, truncated: false, error: null,
    });
    reconcileSpy.mockResolvedValue({ posted: 1, updated: 0, failed: [] });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).toHaveBeenCalledOnce();
    const arg = reconcileSpy.mock.calls[0][0] as { analyzedSha: string; items: unknown[] };
    expect(arg.analyzedSha).toBe('sha123');
    expect(arg.items).toHaveLength(1);
    expect(outputs['inline-findings-posted']).toBe('1');
    expect(outputs['inline-findings-suppressed']).toBe('2');
    // Nothing demoted/failed → the main comment is NOT re-posted.
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('flag ON: appends the fallback section by UPDATING the main comment directly (id reuse)', async () => {
    inputs['inline-findings'] = 'true';
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [anchoredItem, demotedItem],
      suppressedCount: 0, truncated: false, error: null,
    });
    reconcileSpy.mockResolvedValue({ posted: 1, updated: 0, failed: [] });
    const { main } = await import('../src/main');
    await main();
    // §7 posts the main comment once; §6d reuses its id via a direct
    // updateComment instead of re-listing the thread to rediscover it.
    expect(postSpy).toHaveBeenCalledOnce();
    expect(updateCommentSpy).toHaveBeenCalledOnce();
    const fallbackCall = updateCommentSpy.mock.calls[0][0] as {
      comment_id: number;
      body: string;
    };
    expect(fallbackCall.comment_id).toBe(1); // the id §7's post returned
    expect(fallbackCall.body).toContain('## Findings not shown inline');
  });

  it('flag ON: surfaces the Hub time-box marker even with nothing demoted', async () => {
    inputs['inline-findings'] = 'true';
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [anchoredItem],
      suppressedCount: 0, truncated: true, error: null,
    });
    reconcileSpy.mockResolvedValue({ posted: 1, updated: 0, failed: [] });
    const { main } = await import('../src/main');
    await main();
    expect(updateCommentSpy).toHaveBeenCalledOnce();
    const body = (updateCommentSpy.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain('time budget');
  });

  it('flag ON but the Hub reported a findings error: skips entirely, outputs 0', async () => {
    inputs['inline-findings'] = 'true';
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [],
      suppressedCount: 0, truncated: false, error: 'unsupported findings schema',
    });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(outputs['inline-findings-posted']).toBe('0');
    expect(outputs['inline-findings-suppressed']).toBe('0');
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('flag ON but no findings envelope (old Hub): skips, outputs 0', async () => {
    inputs['inline-findings'] = 'true';
    await setupBlast(undefined);
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(outputs['inline-findings-posted']).toBe('0');
  });

  it('severity floor "error" narrows out warning findings and counts them suppressed', async () => {
    inputs['inline-findings'] = 'true';
    inputs['inline-severity-floor'] = 'error';
    const warnAnchored = { ...anchoredItem, fingerprint: 'w', severity: 'warning' };
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [anchoredItem, warnAnchored],
      suppressedCount: 0, truncated: false, error: null,
    });
    reconcileSpy.mockResolvedValue({ posted: 1, updated: 0, failed: [] });
    const { main } = await import('../src/main');
    await main();
    const arg = reconcileSpy.mock.calls[0][0] as { items: Array<{ fingerprint: string }> };
    expect(arg.items).toHaveLength(1);
    expect(arg.items[0].fingerprint).toBe('a1');
    expect(outputs['inline-findings-suppressed']).toBe('1');
  });

  it('a thrown reconcile never fails the run; outputs still resolve', async () => {
    inputs['inline-findings'] = 'true';
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [anchoredItem],
      suppressedCount: 0, truncated: false, error: null,
    });
    reconcileSpy.mockRejectedValue(new Error('reconcile boom'));
    const { main } = await import('../src/main');
    await main();
    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(outputs['inline-findings-posted']).toBe('0');
    expect(outputs['gate-decision']).toBe('neutral');
  });

  it('fork + flag ON: still ATTEMPTS inline findings, degrades on 403, never fails', async () => {
    inputs['inline-findings'] = 'true';
    ghContext.payload.repository = { full_name: 'Akon-Labs/gitnexus-enterprise' };
    ghContext.payload.pull_request.head = {
      sha: undefined,
      repo: { full_name: 'attacker/gitnexus-enterprise' },
    };
    await setupBlast({
      schemaVersion: '1', analyzedSha: 'sha', items: [anchoredItem],
      suppressedCount: 0, truncated: false, error: null,
    });
    // A fork's read-only token 403s the main comment (log-only); reconcile
    // degrades every finding to the fallback, whose post also 403s (swallowed).
    postSpy.mockRejectedValue(FORBIDDEN_403);
    reconcileSpy.mockResolvedValue({ posted: 0, updated: 0, failed: [anchoredItem] });
    const { main } = await import('../src/main');
    await main();
    // Inline findings are ATTEMPTED even on a fork (a fork may carry write access).
    expect(reconcileSpy).toHaveBeenCalledOnce();
    expect(outputs['inline-findings-posted']).toBe('0');
    expect(setFailedSpy).not.toHaveBeenCalled();
  });
});

describe('main — gated draft-skip (Wave 2)', () => {
  async function setupHappy(): Promise<void> {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    getBlastSpy.mockResolvedValue(normalizeBlastResult(blastRaw));
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });
  }

  it('draft + flag ON: exits before any Hub call and posts nothing', async () => {
    inputs['inline-findings'] = 'true';
    ghContext.payload.pull_request.draft = true;
    await setupHappy();
    const { main } = await import('../src/main');
    await main();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(getBlastSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(setFailedSpy).not.toHaveBeenCalled();
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged.toLowerCase()).toContain('draft');
  });

  it('draft + flag OFF: normal run (draft-skip is gated behind inline-findings)', async () => {
    ghContext.payload.pull_request.draft = true; // flag off by default
    await setupHappy();
    const { main } = await import('../src/main');
    await main();
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('non-draft + flag ON: runs normally (not skipped)', async () => {
    inputs['inline-findings'] = 'true';
    ghContext.payload.pull_request.draft = false;
    await setupHappy();
    const { main } = await import('../src/main');
    await main();
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(postSpy).toHaveBeenCalled();
  });
});

describe('main — D1 App-primary gate', () => {
  const anchoredItem = {
    fingerprint: 'a1',
    checkId: 'chk',
    origin: 'deterministic',
    severity: 'error',
    confidence: 1,
    title: 'boom',
    rationale: 'why',
    path: 'src/a.ts',
    anchored: true,
    anchor: { startLine: 10, endLine: 10 },
  };
  const demotedItem = {
    fingerprint: 'd1',
    checkId: 'chk',
    origin: 'generated',
    severity: 'warning',
    confidence: 0.9,
    title: 'soft',
    rationale: 'demoted',
    path: 'src/b.ts',
    anchored: false,
  };

  async function setupBlast(over: Record<string, unknown>): Promise<void> {
    resolveSpy.mockResolvedValue('repo-uuid');
    refreshSpy.mockResolvedValue(undefined);
    const blastRaw = loadFullBlast();
    const { isBlastResult, normalizeBlastResult } = await import('../src/types/blast-result');
    if (!isBlastResult(blastRaw)) throw new Error('bad fixture');
    const blast = normalizeBlastResult(blastRaw) as Record<string, unknown>;
    Object.assign(blast, over);
    getBlastSpy.mockResolvedValue(blast);
    postSpy.mockResolvedValue({ commentId: 1, action: 'created' });
  }

  it('App owns SUMMARY → does NOT post the main comment, but the gate still runs', async () => {
    await setupBlast({ appReview: { active: true, summary: true, inlineFindings: false } });
    const { main } = await import('../src/main');
    await main();
    expect(postSpy).not.toHaveBeenCalled(); // ceded to the App
    expect(outputs['blast-level']).toBe('LOW'); // gate still ran from blastLevel
    expect(setFailedSpy).not.toHaveBeenCalled();
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('owns the summary comment');
  });

  it('App owns SUMMARY → does NOT post the since-last-commit comment either', async () => {
    await setupBlast({
      appReview: { active: true, summary: true, inlineFindings: false },
      sinceLastCommit: { headSha: 'deadbee', summary: 'delta prose' },
    });
    const { main } = await import('../src/main');
    await main();
    // postSpy backs BOTH the main comment and the since-last-commit comment.
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('App owns INLINE FINDINGS → does NOT reconcile, but still posts the summary (surface not ceded)', async () => {
    inputs['inline-findings'] = 'true';
    ghContext.payload.pull_request.head = { sha: 'abc1234' };
    await setupBlast({
      appReview: { active: true, summary: false, inlineFindings: true },
      findings: {
        schemaVersion: '1',
        analyzedSha: 'abc1234',
        items: [anchoredItem],
        suppressedCount: 0,
        truncated: false,
        error: null,
      },
    });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).not.toHaveBeenCalled(); // inline ceded to the App
    expect(postSpy).toHaveBeenCalledOnce(); // summary NOT ceded → Action still posts it
    expect(outputs['inline-findings-posted']).toBe('0');
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('owns inline findings');
  });

  it('default appReview (all-false) → posts as legacy (App owns nothing)', async () => {
    await setupBlast({ appReview: { active: false, summary: false, inlineFindings: false } });
    const { main } = await import('../src/main');
    await main();
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('App owns SUMMARY + inline active + demoted findings → reconciles inline but NEVER re-posts the summary (no double-post)', async () => {
    // The exact per-surface split D1 supports. Regression guard: the demoted-findings
    // fallback must NOT re-create the ceded summary comment under COMMENT_MARKER.
    inputs['inline-findings'] = 'true';
    ghContext.payload.pull_request.head = { sha: 'abc1234' };
    reconcileSpy.mockResolvedValue({ posted: 1, updated: 0, failed: [] });
    await setupBlast({
      appReview: { active: true, summary: true, inlineFindings: false },
      findings: {
        schemaVersion: '1',
        analyzedSha: 'abc1234',
        items: [anchoredItem, demotedItem], // demotedItem (non-anchored) → fallback section
        suppressedCount: 0,
        truncated: false,
        error: null,
      },
    });
    const { main } = await import('../src/main');
    await main();
    expect(reconcileSpy).toHaveBeenCalledOnce(); // inline surface NOT ceded → still posts
    expect(postSpy).not.toHaveBeenCalled(); // summary ceded → NO summary comment re-created
    expect(updateCommentSpy).not.toHaveBeenCalled(); // no Action main comment to update
    const logged = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('not re-posting'); // demoted findings logged instead
  });
});
