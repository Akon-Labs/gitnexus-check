/**
 * @brief: Live demo render + SLM readability pass. Identical to render-live.ts
 *         (pulls REAL data from the hosted GitNexus Hub and renders it through
 *         the actual PR-comment renderer), then runs the rendered markdown
 *         through a small language model on Azure to make it more
 *         engineer-readable. The SLM ONLY summarizes and tidies — it never
 *         invents findings, changes numbers, or generates new analysis. The
 *         deterministic renderer stays the source of truth.
 *
 *         Flow:
 *           1. resolve the subject repo on the Hub        GET /api/repos
 *           2. fetch a real PR blast                       GET /api/repos/:id/prs/:n
 *           3. pull real cross-repo bridge edges           GET /api/groups/:gid/graph/galaxy
 *           4. graft (3) onto (2) as the v2 crossRepo envelope and renderComment
 *           5. summarize the markdown via the Azure SLM    (presentation only)
 *           6. write both the raw and the SLM-formatted markdown to disk
 *
 * Auth:
 *   - GNX_TOKEN       (gnx_ device token) — for the Hub. Read from .env, never printed.
 *   - AZURE_API_TOKEN (Azure AI API key) — for the SLM. Read from .env, never printed.
 *
 * Usage:
 *   npx tsx scripts/render-live-slm.ts [repoFullName] [prNumber] [groupName]
 *   npx tsx scripts/render-live-slm.ts --raw [repoFullName] [prNumber] [groupName]  # skip SLM
 *
 * Defaults: repo = Akon-Labs/gitnexus-enterprise, PR = most recent, group = z-akon.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderComment } from '../src/render-comment';
import { isBlastResult, normalizeBlastResult } from '../src/types/blast-result';
import { AZURE_DEPLOYMENT, composeWithDigest, summarizeWithSlm } from './slm-format';

const HUB = 'https://gitnexus-enterprise-production.up.railway.app';

// ── CLI args (a leading --raw flag skips the SLM pass) ───────────────────────
const argv = process.argv.slice(2);
const SKIP_SLM = argv.includes('--raw');
const positional = argv.filter((a) => !a.startsWith('--'));
const SUBJECT = positional[0] ?? 'Akon-Labs/gitnexus-enterprise';
const PR_ARG = positional[1] ? Number(positional[1]) : null;
const GROUP_NAME = positional[2] ?? 'z-akon';

/**
 * @brief: Read a single KEY=value entry from the repo-root .env without pulling
 *         in dotenv. Tolerates optional surrounding quotes. Returns '' when the
 *         key is absent/empty.
 */
function readEnvVar(name: string): string {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  if (!line) return '';
  return line.slice(`${name}=`.length).trim().replace(/^["']|["']$/g, '');
}

const TOKEN = readEnvVar('GNX_TOKEN');
if (!TOKEN) throw new Error('GNX_TOKEN not found in .env');

async function hubGet(p: string): Promise<any> {
  const res = await fetch(`${HUB}${p}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      'X-Device-Fingerprint': 'gitnexus-check-action',
    },
  });
  if (!res.ok) throw new Error(`GET ${p} → ${res.status} ${res.statusText}`);
  return res.json();
}

function asArray(x: any): any[] {
  return Array.isArray(x) ? x : (x?.repos ?? x?.groups ?? x?.prs ?? x?.items ?? []);
}

async function main(): Promise<void> {
  // 1. Resolve the subject repo's Hub id.
  const repos = asArray(await hubGet('/api/repos'));
  const repo = repos.find((r) => (r.fullName ?? r.full_name) === SUBJECT);
  if (!repo) throw new Error(`repo ${SUBJECT} not found on Hub`);

  // 2. Pick a real PR (explicit arg, else most recent) and fetch its real blast.
  const prs = asArray(await hubGet(`/api/repos/${repo.id}/prs`));
  if (prs.length === 0) throw new Error(`no PRs for ${SUBJECT}`);
  const prNumber = PR_ARG ?? (prs[0].prNumber ?? prs[0].pr_number);
  const base = await hubGet(`/api/repos/${repo.id}/prs/${prNumber}`);

  // 3. Find the group and pull the real bridge edges from the galaxy view.
  const groups = asArray(await hubGet('/api/groups'));
  const group = groups.find((g) => g.name === GROUP_NAME) ?? groups[0];
  if (!group) throw new Error('no group found');
  const galaxy = await hubGet(`/api/groups/${group.id}/graph/galaxy`);
  const edges: any[] = galaxy.symbolEdges ?? [];

  // 4. Build cross-repo findings: edges where the SUBJECT is the provider
  //    (target). consumer = the edge source repo. Dedupe by (consumer, via).
  const seen = new Set<string>();
  const findings = edges
    .filter((e) => e.targetRepo === SUBJECT && e.sourceRepo !== e.targetRepo)
    .filter((e) => {
      const k = `${e.sourceRepo}|${e.reason}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((e) => ({
      kind: 'contract' as const,
      consumerRepo: e.sourceRepo,
      via: e.reason,
      edgeType: e.type ?? 'CALLS',
      detectionTier: e.tier ?? '',
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
    }))
    .sort((a, b) => b.confidence - a.confidence || a.via.localeCompare(b.via));

  // 5. Graft the real edges onto the real PR blast as the v2 crossRepo envelope.
  const merged = {
    ...base,
    crossRepo: {
      schemaVersion: '1',
      findings,
      groups: [
        {
          id: group.id,
          name: group.name,
          lastAnalyzedAt: group.lastAnalyzedAt ?? group.last_analyzed_at ?? null,
          stale: Boolean(group.stale),
        },
      ],
      truncated: false,
      error: null,
    },
  };

  if (!isBlastResult(merged)) throw new Error('assembled blast failed isBlastResult');
  const raw = renderComment(normalizeBlastResult(merged), { prNumber, hubUrl: HUB });

  // 6. Presentation pass through the Azure SLM (unless --raw).
  let formatted = raw;
  let usedSlm = false;
  if (!SKIP_SLM) {
    const apiKey = readEnvVar('AZURE_API_TOKEN');
    if (!apiKey) {
      console.warn(
        '[render-live-slm] AZURE_API_TOKEN not set in .env — skipping SLM pass, writing raw markdown.',
      );
    } else {
      try {
        const digest = await summarizeWithSlm(raw, apiKey);
        formatted = composeWithDigest(raw, digest);
        usedSlm = true;
      } catch (err) {
        console.warn(
          `[render-live-slm] SLM formatting failed (${(err as Error).message}); writing raw markdown.`,
        );
        formatted = raw;
      }
    }
  }

  // Write both variants to test/results/pr-flow/ for inspection.
  const outDir = path.join(__dirname, '..', 'test', 'results', 'pr-flow');
  fs.mkdirSync(outDir, { recursive: true });
  const safeRepo = SUBJECT.replace(/[/\\]/g, '-');
  const rawPath = path.join(outDir, `${safeRepo}-pr${prNumber}-raw.md`);
  const readmePath = path.join(outDir, `${safeRepo}-pr${prNumber}.md`);
  fs.writeFileSync(rawPath, raw);
  fs.writeFileSync(readmePath, formatted);

  console.log(
    `[render-live-slm] repo=${SUBJECT} PR #${prNumber} blast=${merged.blastLevel} | ` +
      `cross-repo findings=${findings.length} | group=${group.name} | ` +
      `slm=${usedSlm ? AZURE_DEPLOYMENT : 'off'} | raw=${raw.length} → formatted=${formatted.length} chars`,
  );
  console.log(`raw markdown      → ${rawPath}`);
  console.log(`formatted readme  → ${readmePath}`);
}

main().catch((err) => {
  console.error(`render-live-slm failed: ${(err as Error).message}`);
  process.exit(1);
});
