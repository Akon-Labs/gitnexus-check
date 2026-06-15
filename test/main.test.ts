/**
 * Orchestration tests for src/main.ts. We mock every collaborator
 * (axios, @actions/exec, github.context, fs writes via tmpdir) and
 * assert on the high-level wiring:
 *
 *   - happy path with reindex (big-diff): bundle + upload + poll runs,
 *     context-pack fetched, artifacts written, outputs set.
 *   - lazy-skip path (small diff, no label): no bundle/upload, just
 *     context-pack + artifacts.
 *   - deep-review label opt-in: even on a small diff, reindex runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// We need to mock @actions/core, @actions/github, @actions/exec, and
// axios BEFORE importing main. Hoist the mocks.

vi.mock('@actions/exec', () => ({
  exec: vi.fn().mockResolvedValue(0),
}));

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

// In-memory step output store so we can assert what main() set.
const outputs: Record<string, string> = {};
const inputs: Record<string, string> = {};

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => inputs[name] ?? ''),
  setOutput: vi.fn((name: string, value: string) => {
    outputs[name] = value;
  }),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
}));

const ghContext = {
  eventName: 'pull_request',
  payload: {
    pull_request: {
      number: 42,
      head: { ref: 'feat/x', sha: 'headsha' },
      base: { sha: 'basesha' },
      html_url: 'https://github.com/a/b/pull/42',
      labels: [] as Array<{ name: string }>,
    },
  },
  repo: { owner: 'a', repo: 'b' },
};

vi.mock('@actions/github', () => ({
  context: ghContext,
}));

import axios from 'axios';
import * as exec from '@actions/exec';

const mockedAxios = vi.mocked(axios, true);
const mockedExec = vi.mocked(exec.exec);

let workspace: string;
let originalWorkspace: string | undefined;
let originalCwd: string;

function resetMain(): void {
  // main.ts auto-runs on import. We re-import per-test to retrigger
  // the orchestration with fresh mocks. The vitest module cache must
  // be cleared between runs.
  vi.resetModules();
}

function setHappyPathMocks(opts: {
  status?: 'ready' | 'pending';
  bigDiff: boolean;
  rename?: boolean;
}): void {
  // /api/repos -> resolveRepoId
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/repos')) {
      return { data: { repos: [{ id: 'repoid', fullName: 'a/b' }] } };
    }
    if (url.includes('/branch-reindex/') && url.endsWith('/status')) {
      return { data: { status: 'ready', indexedCommit: 'deadbeef' } };
    }
    throw new Error(`unexpected GET ${url}`);
  });

  mockedAxios.post.mockImplementation(async (url: string) => {
    if (url.includes('/branch-reindex')) {
      return {
        data: {
          id: 'job1',
          status: 'queued',
          statusUrl: '/api/repos/repoid/branch-reindex/42/status',
        },
      };
    }
    if (url.includes('/context-pack')) {
      return {
        data: {
          schemaVersion: 1,
          repo: { id: 'repoid', fullName: 'a/b', indexedCommit: null, lastIndexedAt: null },
          warningsForClaude: [],
        },
      };
    }
    throw new Error(`unexpected POST ${url}`);
  });

  // git diff --numstat output
  const numstat = opts.bigDiff
    ? Array.from({ length: 60 }, (_, i) => `1\t1\tsrc/f${i}.ts`).join('\n') + '\n'
    : opts.rename
      ? '5\t2\tsrc/old.ts\tsrc/new.ts\n'
      : '10\t2\tsrc/a.ts\n';
  const nameStatus = opts.bigDiff
    ? Array.from({ length: 60 }, (_, i) => `M\tsrc/f${i}.ts`).join('\n') + '\n'
    : opts.rename
      ? 'R100\tsrc/old.ts\tsrc/new.ts\n'
      : 'M\tsrc/a.ts\n';

  mockedExec.mockImplementation(async (_cmd, args, options) => {
    const argv = (args ?? []).join(' ');
    if (argv.startsWith('diff --numstat')) {
      options?.listeners?.stdout?.(Buffer.from(numstat));
      return 0;
    }
    if (argv.startsWith('diff --name-status')) {
      options?.listeners?.stdout?.(Buffer.from(nameStatus));
      return 0;
    }
    // update-ref / bundle create — succeed silently
    return 0;
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-main-test-'));
  originalWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = workspace;
  originalCwd = process.cwd();

  // Reset shared state.
  for (const k of Object.keys(outputs)) delete outputs[k];
  for (const k of Object.keys(inputs)) delete inputs[k];
  inputs['hub-url'] = 'https://hub.example.com';
  inputs['token'] = 'gnx_test';
  inputs['deep-review-label'] = 'gitnexus-deep-review';
  inputs['lazy-reindex'] = 'true';
  ghContext.payload.pull_request.labels = [];
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
  mockedExec.mockReset();
});

afterEach(() => {
  if (originalWorkspace === undefined) {
    delete process.env.GITHUB_WORKSPACE;
  } else {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('main — happy path with full reindex (big diff)', () => {
  it('bundles, uploads, polls, fetches context pack, writes artifacts', async () => {
    setHappyPathMocks({ bigDiff: true });
    resetMain();
    await import('../src/main');
    // Allow the auto-run main() promise chain to settle.
    await new Promise((r) => setImmediate(r));

    // Bundle was created (update-ref + bundle create).
    const execCalls = mockedExec.mock.calls.map((c) => c[1]?.join(' ') ?? '');
    expect(execCalls.some((c) => c.startsWith('update-ref'))).toBe(true);
    expect(execCalls.some((c) => c.startsWith('bundle create'))).toBe(true);

    // Bundle uploaded.
    const postUrls = mockedAxios.post.mock.calls.map((c) => c[0]);
    expect(postUrls.some((u: string) => u.endsWith('/branch-reindex'))).toBe(true);

    // Status polled.
    const getUrls = mockedAxios.get.mock.calls.map((c) => c[0]);
    expect(getUrls.some((u: string) => u.includes('/branch-reindex/42/status'))).toBe(true);

    // Context pack fetched.
    expect(postUrls.some((u: string) => u.endsWith('/context-pack'))).toBe(true);

    // Artifacts written under workspace.
    expect(fs.existsSync(path.join(workspace, '.gitnexus', 'context-pack.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.gitnexus', 'system-prompt.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.claude', 'gitnexus-mcp.json'))).toBe(true);

    // Outputs set with absolute paths.
    expect(outputs['context-pack-path']).toBe(
      path.join(workspace, '.gitnexus', 'context-pack.json'),
    );
    expect(outputs['system-prompt-path']).toBe(
      path.join(workspace, '.gitnexus', 'system-prompt.md'),
    );
    expect(outputs['mcp-config-path']).toBe(path.join(workspace, '.claude', 'gitnexus-mcp.json'));
    expect(outputs['indexed-commit']).toBe('deadbeef');
  });
});

describe('main — lazy-skip path (small diff, no label)', () => {
  it('skips bundle + upload, only fetches context pack', async () => {
    setHappyPathMocks({ bigDiff: false });
    resetMain();
    await import('../src/main');
    await new Promise((r) => setImmediate(r));

    // No bundle / no upload.
    const execCalls = mockedExec.mock.calls.map((c) => c[1]?.join(' ') ?? '');
    expect(execCalls.some((c) => c.startsWith('update-ref'))).toBe(false);
    expect(execCalls.some((c) => c.startsWith('bundle create'))).toBe(false);

    const postUrls = mockedAxios.post.mock.calls.map((c) => c[0]);
    expect(postUrls.some((u: string) => u.endsWith('/branch-reindex'))).toBe(false);

    // Context pack still fetched.
    expect(postUrls.some((u: string) => u.endsWith('/context-pack'))).toBe(true);

    // Artifacts written.
    expect(fs.existsSync(path.join(workspace, '.gitnexus', 'context-pack.json'))).toBe(true);
    expect(outputs['context-pack-path']).toBeTruthy();
    expect(outputs['indexed-commit']).toBeUndefined();
  });
});

describe('main — deep-review label opt-in', () => {
  it('forces reindex even on a small diff', async () => {
    setHappyPathMocks({ bigDiff: false });
    ghContext.payload.pull_request.labels = [{ name: 'gitnexus-deep-review' }];
    resetMain();
    await import('../src/main');
    await new Promise((r) => setImmediate(r));

    const postUrls = mockedAxios.post.mock.calls.map((c) => c[0]);
    expect(postUrls.some((u: string) => u.endsWith('/branch-reindex'))).toBe(true);
    expect(outputs['indexed-commit']).toBe('deadbeef');
  });
});

describe('main — rename triggers reindex', () => {
  it('reindexes when diff contains a rename, even on small file count', async () => {
    setHappyPathMocks({ bigDiff: false, rename: true });
    resetMain();
    await import('../src/main');
    await new Promise((r) => setImmediate(r));

    const postUrls = mockedAxios.post.mock.calls.map((c) => c[0]);
    expect(postUrls.some((u: string) => u.endsWith('/branch-reindex'))).toBe(true);
  });
});
