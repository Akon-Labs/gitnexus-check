/**
 * @brief: Shared SLM "readability pass" used by render-fixture.ts and
 *         render-live-slm.ts.
 *
 *         Design — HYBRID, not a full rewrite. A model asked to re-type the
 *         deterministic comment's large tables (160+ symbols, 100+ files, 50+
 *         flows) reliably miscounts, duplicates rows, and misattributes file
 *         paths — i.e. it alters facts, which we never allow. So we split the
 *         work:
 *
 *           • The SLM writes ONLY a short, human-readable "## Summary" digest
 *             (TL;DR + review focus + by-area overview + cross-repo highlight).
 *             It restates aggregate numbers/names already in the report, so it
 *             cannot fabricate row-level data.
 *           • The exact detail tables stay verbatim from the deterministic
 *             renderer (composeWithDigest inserts the digest above them).
 *
 *         Result: a comment that reads well up top and is 100% accurate below.
 *         The deterministic renderer remains the source of truth.
 *
 * Auth: API key (Azure AI), passed in by the caller (read from .env). Never logged.
 */

import OpenAI from 'openai';

// ── Azure AI deployment (OpenAI-compatible v1 endpoint) ──────────────────────
export const AZURE_ENDPOINT = 'https://akonlabs.services.ai.azure.com/openai/v1';
export const AZURE_DEPLOYMENT = 'DeepSeek-V4-Flash';

/**
 * @brief: Instruction for the digest pass. The model produces ONLY the summary
 *         block — never the marker, header, metrics table, or the full detail
 *         lists (those are kept verbatim by composeWithDigest). It restates
 *         aggregate facts the report already contains; it never invents or
 *         alters a number, name, path, or level.
 */
export const SLM_SYSTEM_PROMPT = [
  'You are a senior staff engineer writing the executive summary at the top of an automated pull-request review comment, so a busy reviewer instantly knows what this PR touches and where the risk is.',
  '',
  'You are given the full deterministic report (verdict, metrics, symbol/file/flow tables, cross-repo impact, risk files, recommendations). Write ONLY a concise summary block. The full detailed tables already appear below your summary, so DO NOT reproduce them.',
  '',
  '## Absolute faithfulness (never break these)',
  '- Restate only what the report says. Never invent, infer, or add a finding, cause, or fix.',
  '- Copy every number, file path, symbol name, repository name, route, topic, blast level, and risk level VERBATIM. Never round or rename.',
  '- Use only aggregate facts the report states directly (the headline counts, the Architecture Impact module hits, the cross-repo repos/interfaces, the "How to reduce the blast radius" bullets). Do NOT try to re-count or re-list individual symbols/files/flows — that is what the tables below are for.',
  '- Never describe or speculate about the code change itself (no diffs, no "this likely…").',
  '',
  '## Output exactly this structure, nothing before or after',
  'Start with the single heading `## Summary`. Everything else uses BOLD inline labels, NOT `##` headings (the report already has its own `##` sections below yours — do not collide with them). In order:',
  '1. A one-line TL;DR led by the blast-level emoji (🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW — match the report): the level, the headline counts (dependents / modules / flows / files), and cross-repo reach if any. One sentence, no label.',
  '2. `**Review focus:**` — for HIGH/CRITICAL only: 2-4 tight bullets pointing at the riskiest spots the report ALREADY names — the hottest file and its symbol count (from the recommendations), the modules with the most hits (from Architecture Impact), the cross-repo consumer repos, and any HIGH/CRITICAL risk files. Pure restatement. Omit this label entirely for LOW/MEDIUM.',
  '3. `**By area:**` — 3-6 bullets using the Architecture Impact module names + hit counts (e.g. "`Services` — 24 hits", "`Auth` — 19 hits"). High level only; no per-symbol lists.',
  '4. `**Cross-repo:**` — one line naming each consumer repo and its interface count (e.g. "`zander-raycraft/GitNexus` — 12 interfaces: 8 HTTP routes, 4 messaging topics"). Omit if there are none.',
  '',
  '## Style',
  '- Tight bullets, plain language. Wrap every symbol, path, module, route, and topic in single backticks — and make sure each backtick is paired (no stray or doubled backticks).',
  '- Do not wrap plain numbers in backticks unless they are part of a code token; write "5 modules", not "`5` modules".',
  '- Keep the whole summary under ~18 lines. It is a digest, not the report.',
  '- Put a blank line after each bold label (`**Review focus:**`, `**By area:**`, `**Cross-repo:**`) before its bullet list, so the list renders correctly on GitHub.',
  '- Valid GitHub-flavored Markdown. The only `##` heading you emit is `## Summary`. Output nothing else.',
].join('\n');

/**
 * @brief: Ask the Azure-hosted SLM for the summary digest. Uses the Chat
 *         Completions API (DeepSeek is a chat model, not a gpt-5 reasoning
 *         model): the editor instruction is the system message, the report is
 *         the user message. Low temperature keeps it faithful. Returns the
 *         digest markdown, or throws on any API failure (the caller decides
 *         whether to fall back to the raw deterministic comment).
 *
 * @params: (markdown: string) -> Deterministic comment from renderComment.
 * @params: (apiKey: string)   -> Azure AI API key (from .env). Never logged.
 * @returns: string — the `## Summary` digest block.
 */
export async function summarizeWithSlm(markdown: string, apiKey: string): Promise<string> {
  // maxRetries lets the SDK back off and honor Retry-After on 429s, which this
  // shared deployment returns under load; the timeout caps a single attempt.
  const client = new OpenAI({ baseURL: AZURE_ENDPOINT, apiKey, maxRetries: 5, timeout: 60_000 });
  const completion = await client.chat.completions.create({
    model: AZURE_DEPLOYMENT,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SLM_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Write the executive summary for this PR review comment, following every rule above:\n\n${markdown}`,
      },
    ],
  });
  const out = completion.choices[0]?.message?.content?.trim();
  if (!out) throw new Error('SLM returned an empty completion');
  return out;
}

/**
 * @brief: Splice the SLM digest into the deterministic comment and collapse the
 *         heavy detail beneath it. The default-visible comment becomes just the
 *         header, one-line verdict, metrics strip, and the readable `## Summary`
 *         digest — so a 160-symbol / 100-file PR no longer floods the thread.
 *         Every detail table (symbols, files, flows, risk, cross-repo) is kept
 *         verbatim from the renderer but tucked inside ONE collapsed
 *         `<details>` expander, one click away. Falls back to appending the
 *         digest if there is no detail body (empty-blast comment).
 *
 * @params: (rawComment: string) -> Full deterministic comment from renderComment.
 * @params: (digest: string)     -> The `## Summary` block from summarizeWithSlm.
 * @returns: string — the composed, concise comment.
 */
export function composeWithDigest(rawComment: string, digest: string): string {
  const block = digest.trim();
  const sep = '\n---\n';
  const i = rawComment.indexOf(sep);
  if (i === -1) {
    // No section divider (empty-blast comment): nothing heavy to collapse.
    return `${rawComment.trimEnd()}\n\n---\n\n${block}\n`;
  }
  // Split at the first divider: head = marker/header/verdict/metrics, rest =
  // all the detail sections. Rebuild as head → Summary → one collapsed expander.
  const head = rawComment.slice(0, i).trimEnd();
  const rest = rawComment.slice(i + sep.length).trim();
  const summary = buildDetailSummary(rawComment);
  return (
    `${head}\n\n${block}\n\n---\n\n` +
    `<details>\n<summary><b>${summary}</b></summary>\n\n${rest}\n\n</details>\n`
  );
}

/**
 * @brief: Build the collapsed-expander summary line, e.g.
 *         "📋 Full report — 162 symbols · 117 files · 58 flows", pulling the
 *         counts straight from the renderer's own section headers so they stay
 *         exact. Returns a bare label when no counts are found.
 */
function buildDetailSummary(rawComment: string): string {
  const sym = rawComment.match(/Symbol Changes \((\d+)\)/);
  const files = rawComment.match(/Changed Files \((\d+)\)/);
  const flows = rawComment.match(/Affected Flows \((\d+)\)/);
  const parts: string[] = [];
  if (sym) parts.push(`${sym[1]} symbols`);
  if (files) parts.push(`${files[1]} files`);
  if (flows) parts.push(`${flows[1]} flows`);
  return parts.length > 0 ? `📋 Full report — ${parts.join(' · ')}` : '📋 Full report';
}
