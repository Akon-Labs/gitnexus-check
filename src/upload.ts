import axios from 'axios';
import FormData from 'form-data';
import * as fs from 'node:fs';

/**
 * Bundle upload + status polling against the Hub's lean Phase-2
 * branch-reindex endpoint. Differences from v1:
 *   - No checks fan-out — Claude runs in a separate workflow step.
 *   - No coverage upload here.
 *   - The `runChecks` helper from v1 is removed.
 */

export interface ReindexResult {
  id: string;
  status: string;
  statusUrl: string;
}

export interface IndexReady {
  indexedCommit: string;
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

  const res = await axios.post(`${opts.hubUrl}/api/repos/${opts.repoId}/branch-reindex`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${opts.token}` },
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 100 * 1024 * 1024,
  });
  return res.data;
}

/**
 * Poll the status URL until indexing is `ready` or `error`.
 *
 * pollIntervalMs is exposed so tests can run with 0 (fake-time loop)
 * without sleeping for real.
 */
export async function pollUntilReady(opts: {
  statusUrl: string;
  hubUrl: string;
  token: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<IndexReady> {
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const interval = opts.pollIntervalMs ?? 3000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const res = await axios.get(`${opts.hubUrl}${opts.statusUrl}`, {
      headers: { Authorization: `Bearer ${opts.token}` },
    });
    if (res.data.status === 'ready') return { indexedCommit: res.data.indexedCommit };
    if (res.data.status === 'error') throw new Error(`indexing failed: ${res.data.error}`);
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('indexing timed out');
}
