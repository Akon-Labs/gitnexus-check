import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'node:fs';

export interface ReindexResult {
  id: string;
  status: string;
  statusUrl: string;
}

export interface CheckSuiteResult {
  prNumber: number;
  checks: Array<{
    id: string;
    title: string;
    severity: 'pass' | 'warn' | 'fail';
    summary: string;
    details: Array<{
      location: { file: string; line: number; column?: number };
      message: string;
      evidence?: unknown;
    }>;
  }>;
  warRoomUrl: string;
  durationMs: number;
  /**
   * Per-repo Claude opt-in flag, surfaced from the Hub so the action can
   * decide whether to render "Fix with Claude →" links in the PR comment.
   * Optional for backwards-compat with older Hubs that don't yet send it.
   * Phase 13 of the CI integration plan.
   */
  repo?: {
    claudeEnabled: boolean;
  };
}

export async function uploadBundle(opts: {
  hubUrl: string;
  token: string;
  repoId: string;
  prNumber: number;
  branchName: string;
  bundlePath: string;
}): Promise<ReindexResult> {
  const form = new FormData();
  form.append('prNumber', String(opts.prNumber));
  form.append('branchName', opts.branchName);
  form.append('bundle', fs.createReadStream(opts.bundlePath));

  // POST to the bundle-upload route specifically, distinct from the
  // generic `/:id/reindex` which only triggers a re-clone and doesn't
  // accept a bundle.
  const res = await axios.post(
    `${opts.hubUrl}/api/repos/${opts.repoId}/branch-reindex`,
    form,
    {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${opts.token}` },
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 100 * 1024 * 1024,
    },
  );
  return res.data;
}

export async function pollUntilReady(opts: {
  statusUrl: string;
  hubUrl: string;
  token: string;
  timeoutMs?: number;
}): Promise<{ indexedCommit: string }> {
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const res = await axios.get(`${opts.hubUrl}${opts.statusUrl}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (res.data.status === 'ready') return { indexedCommit: res.data.indexedCommit };
    if (res.data.status === 'error') throw new Error(`indexing failed: ${res.data.error}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('indexing timed out');
}

export async function runChecks(opts: {
  hubUrl: string;
  token: string;
  repoId: string;
  prNumber: number;
}): Promise<CheckSuiteResult> {
  const res = await axios.post(
    `${opts.hubUrl}/api/repos/${opts.repoId}/checks/${opts.prNumber}`,
    {},
    { headers: { Authorization: `Bearer ${opts.token}` } },
  );
  return res.data;
}
