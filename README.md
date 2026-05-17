# gitnexus-check

GitHub Action that posts a GitNexus blast-radius review comment on every pull request.
It's a thin client around the [GitNexus Enterprise Hub](https://app.akonlabs.com) — the
Hub holds the indexed graph and computes the blast radius; the Action renders the result
into a markdown PR comment and upserts it via the GitHub REST API.

## Quick start

1. **Generate a token.** Log into the Hub → profile → "New CI token" → copy the `gnx_…`
   string.
2. **Link the repo on the Hub.** Add your GitHub repo by full name in the Hub UI.
3. **Add the secret in GitHub.** Repo → Settings → Secrets and variables → Actions →
   New repository secret. Name it `GNX_TOKEN`, paste the token, save.
4. **Add the workflow file** (`.github/workflows/gitnexus-review.yml`):

   ```yaml
   name: GitNexus PR review
   on:
     pull_request:
       types: [opened, synchronize, reopened]

   permissions:
     contents: read
     pull-requests: write   # required to post the comment

   jobs:
     review:
       runs-on: ubuntu-latest
       steps:
         - uses: Akon-Labs/gitnexus-check@v1
           with:
             hub-url: https://app.akonlabs.com
             token: ${{ secrets.GNX_TOKEN }}
   ```

5. **Push.** The Action runs on every PR matching the trigger list. Re-running a failed
   run from the GitHub UI replays the same PR + SHAs — no workflow-file change needed.

Self-hosted Enterprise customers point `hub-url` at their own deployment.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `hub-url` | yes | _(none)_ | Hub base URL. `https://app.akonlabs.com` for SaaS. |
| `token` | yes | _(none)_ | GitNexus CI token (`gnx_…`). Use `${{ secrets.GNX_TOKEN }}`. |
| `github-token` | no | `${{ github.token }}` | Token used for posting the PR comment. |

## Outputs

| Output | Description |
|--------|-------------|
| `comment-id` | GitHub comment id created or updated by this run. |
| `blast-level` | `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL` — overall blast level from the Hub. |

## Required permissions

The consumer workflow **must** grant `pull-requests: write`:

```yaml
permissions:
  contents: read
  pull-requests: write
```

Without this, the Action fails with `Cannot post PR comment: missing
pull-requests:write permission.` rather than a raw 403.

## Fork PRs

`pull_request` events from forks do **not** receive repository secrets, so a forked PR
will fail with a classified 401-class error. v1 documents this limitation; a future
`pull_request_target` opt-in mode is on the roadmap.

## How it works (under the hood)

On every PR event:

1. `resolveRepoId` — `GET /api/repos`, match by `fullName`.
2. `refreshBlast` — `POST /api/repos/:repoId/prs/:prNumber/refresh`. The Hub fetches the
   PR diff via its stored GitHub OAuth grant, walks the graph, and writes
   `pr_blast_results`. As of the v1 cut this endpoint is synchronous and returns in
   ~1–2 s; no polling.
3. `getBlast` — `GET /api/repos/:repoId/prs/:prNumber` returns the full BlastResult JSON.
4. `renderComment` — emits markdown with four sections (Architecture Impact, Blast
   Radius, Symbol Changes, API Surface Delta) under a 60 000-char budget.
5. `postOrUpdateComment` — paginates the PR's issue comments looking for the
   `<!-- gitnexus-review-v1 -->` marker. PATCH if found, POST otherwise.

The Action never reads or transmits repo source code — the Hub does that itself via its
stored OAuth grant.

## Troubleshooting

| Error message (in the Checks tab) | What it means |
|---|---|
| `GNX_TOKEN is invalid or revoked` | Regenerate the token at `<hub>/profile`. |
| `Repo … is not registered on the Hub` | Link the repo on the Hub before re-running. |
| `Plan limit exceeded` | Hub returned 402; upgrade at `<hub>/billing`. |
| `Hub rate limit hit — retry after N seconds` | Wait, then re-run the workflow. |
| `Cannot post PR comment: missing pull-requests:write permission` | Add the permissions block above to your workflow. |
| `Hub returned HTML instead of JSON` | Your `hub-url` points at a non-API host. |

## Versioning

- Tag releases: `v1.0.0`, `v1.0.1`, …
- Moving tag: `v1` always points at the latest `v1.x.y`.
- Consumers should pin `@v1` (recommended) or `@v1.0.0` (exact).

## License

See the project license in the [Akon-Labs/gitnexus-check](https://github.com/Akon-Labs/gitnexus-check) repository.
