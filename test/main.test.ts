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
  info: vi.fn(),
  warning: warningSpy,
  error: errorSpy,
}));

const ghContext = {
  eventName: 'pull_request',
  payload: {
    pull_request: {
      number: 152,
    },
  },
  repo: { owner: 'Akon-Labs', repo: 'gitnexus-enterprise' },
};

const getOctokitSpy = vi.fn(() => ({
  paginate: { iterator: vi.fn() },
  rest: {
    issues: {
      createComment: vi.fn(),
      updateComment: vi.fn(),
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

beforeEach(() => {
  for (const k of Object.keys(outputs)) delete outputs[k];
  for (const k of Object.keys(inputs)) delete inputs[k];
  inputs['hub-url'] = 'https://hub.example.com';
  inputs['token'] = 'gnx_test';
  inputs['github-token'] = 'ghp_test';
  ghContext.eventName = 'pull_request';
  ghContext.payload.pull_request.number = 152;
  setFailedSpy.mockReset();
  warningSpy.mockReset();
  errorSpy.mockReset();
  resolveSpy.mockReset();
  refreshSpy.mockReset();
  getBlastSpy.mockReset();
  postSpy.mockReset();
  parseThresholdSpy.mockReset();
  evaluateGateSpy.mockReset();
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
    expect(msg).toContain('GNX_TOKEN is invalid or revoked');
  });
});

describe('main — GitHub error path', () => {
  it('classifies 403 from GitHub as missing permission', async () => {
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
    const msg = setFailedSpy.mock.calls[0][0] as string;
    expect(msg).toContain('missing pull-requests:write permission');
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

describe('main — token safety', () => {
  it('does not leak the GNX_TOKEN into any setFailed / warning / error call', async () => {
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
