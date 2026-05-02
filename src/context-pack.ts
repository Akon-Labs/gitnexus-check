import axios from 'axios';
import type { DiffFile } from './diff';

/**
 * Wrapper around the Hub's POST /api/repos/:id/context-pack endpoint.
 *
 * Request body shape (matches gitnexus-hub/src/routes/context-pack.ts):
 *   {
 *     prNumber: number,
 *     headSha: string,
 *     baseSha: string,
 *     branch: string,
 *     url?: string,
 *     diff?: { files: DiffFile[], rawDiff?: string }
 *   }
 *
 * The response is the full ContextPack JSON (gitnexus-hub
 * services/context-pack/types.ts) — we treat it as `unknown` here
 * because the action just round-trips it to disk; only Claude reads
 * the contents. Keeping it loosely typed avoids forcing the action
 * package to depend on the Hub's types.
 */
export interface ContextPackRequest {
  prNumber: number;
  headSha: string;
  baseSha: string;
  branch: string;
  url?: string | null;
  diff?: {
    files: DiffFile[];
    rawDiff?: string;
  };
}

export type ContextPack = Record<string, unknown> & {
  schemaVersion: number;
  warningsForClaude?: string[];
};

export async function fetchContextPack(opts: {
  hubUrl: string;
  token: string;
  repoId: string;
  request: ContextPackRequest;
}): Promise<ContextPack> {
  const res = await axios.post(
    `${opts.hubUrl}/api/repos/${opts.repoId}/context-pack`,
    opts.request,
    {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      // Context Pack JSON is small — typically < 500KB even with full
      // changedSymbols + cross-repo data. Bound the body to 5MB so a
      // misbehaving Hub doesn't OOM the runner.
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024,
    },
  );
  return res.data as ContextPack;
}

/**
 * Resolve the repo's UUID on the Hub from its full name. Mirrors v1
 * behaviour and tolerates both camelCase + snake_case shapes for back-
 * compat with older Hub deployments.
 */
export async function resolveRepoId(opts: {
  hubUrl: string;
  token: string;
  fullName: string;
}): Promise<string> {
  const res = await axios.get(`${opts.hubUrl}/api/repos`, {
    headers: { Authorization: `Bearer ${opts.token}` },
  });
  const repos: Array<{ id: string; fullName?: string; full_name?: string }> =
    res.data.repos ?? res.data;
  const match = repos.find((r) => r.fullName === opts.fullName || r.full_name === opts.fullName);
  if (!match) throw new Error(`repo ${opts.fullName} not registered on Hub`);
  return match.id;
}
