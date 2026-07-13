# Inline Review Correctness + Wave 3 — Action-side Plan (2026-07-14)

**Repo:** `gitnexus-check` (the GitHub Action). **Companion:** `gitnexus-enterprise/docs/superpowers/plans/2026-07-14-multi-repo-precision-polyglot-and-findings.md` (Hub/extractor side + Tracks 1 & 3).
**Grounding:** the Action's inline-review path (W2.5–W2.8) is implemented + unit-tested (280 tests) but **not yet live-dogfooded** (`inline-findings` default off; findings render only when the Hub sends the envelope AND `inline-findings: true`).

---

## 0. Current verified state

Shipped + tested on `main` (Akon-Labs/gitnexus-check):
- `blast-result.ts`: tolerant `normalizeFindings` (unknown version → error envelope; malformed items dropped; anchored-without-anchor demoted; fingerprint `/^[0-9a-f]{64}(-\d+)?$/`; integer-only anchor lines).
- `render-findings.ts`: fingerprint-marker comment bodies, severity badges, deterministic caller lists, fallback section; neutralizes comment delimiters / fences / mentions; NO committable suggestion fences (Wave 2).
- `post-review.ts`: bot-actor-filtered reconcile, ONE batched review pinned to `analyzedSha`, 422-only per-comment ladder, anchor-drift → recreate (not PATCH), pending-review cleanup by exact actor.
- `main.ts`: gated draft-skip, best-effort findings block, **freshness guard** (skip inline posting when `findings.analyzedSha !== headSha` — the async stale-SHA read fix), comment errors NEVER `setFailed` (all degrade to log-only), over-cap items demote (not vanish), Hub `truncated` surfaced.

---

## Track 2 items (Action-side)

### T2.A (High) — Live WAVE2-AC dogfood
Once the Hub enables per-repo findings (see enterprise plan T2.1), run WAVE2-AC on real PRs: ≥10 PRs zero attributable failures; ≤10/PR ≤3/file with `suppressedCount` surfaced; automated anchor⊆added-lines check (zero wrong-line anchors); crafted Tier-D breaking-signature PR posts a deterministic finding naming a caller with NO LLM; ≥1 critic-deleted finding logged; same-SHA re-run 0 new/0 dup; draft→ready produces a review; fork degrades without failing; old-Hub byte-identical.

### T2.B (High) — Human-resolved threads must never repost (WAVE2-AC #6, currently a gap)
Wave 2 scans REST review comments only and has no resolved-thread state; GraphQL resolution was deferred to Wave 3. As built, a moved anchor recreates a comment even if the prior thread was human-resolved. **Approach (Wave 3):** add the GraphQL `reviewThreads` query (`isResolved`/`isOutdated`/`replyCount`); skip human-resolved fingerprints PERMANENTLY; stale findings get a "no longer detected as of `<sha>`" reply + `resolveReviewThread` (never delete). Alibaba IoU (>0.6) span-overlap suppression as a secondary near-miss dedup.

### T2.C (Medium) — Provenance labels stay honest
`llm_adjudicated` couplings already render `(LLM-matched)`. When findings gain suggestions (Wave 3), a committable ```suggestion``` fence renders ONLY after the deterministic gates (anchors in added lines, parses under the tree-sitter grammar, `d1 fixSafety` — downgrade to a plain block + a "also update `caller:line`" note when out-of-diff callers exist).

---

## Track 3 (Alibaba) — Action-side
Rule-docs routing (enterprise T3.2) surfaces on the Action only as rendered rule provenance in the comment; no Action change until Wave 3.

---

## Docs to update
- `README.md` — once findings/suggestions go live, document `inline-findings` / `reconcile-findings` inputs and the draft→ready trigger (already partially done).
- This file — keep the `## 0` state current as items land.

## Verification discipline
Every Action change ships with a hand-rolled-client test (the `post-comment`/`post-review` mock idiom), the full suite green (baseline 280), and a rebuilt+verified `dist/` (`npm run build && npm run check-dist` — the committed bundle is the shipping artifact).
