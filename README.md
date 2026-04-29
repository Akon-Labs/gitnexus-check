# GitNexus Checks Action

Runs graph-derived checks against your PR — incomplete renames, dead code, hot-path edits, public API changes, route shape drift, cycle introduction.

## Quick start

```yaml
# .github/workflows/gitnexus.yml
name: GitNexus Checks
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: Akon-Labs/gitnexus-check@v1
        with:
          token: ${{ secrets.GITNEXUS_TOKEN }}
```

## Setup

1. Register your repo on [GitNexus Hub](https://hub.gitnexus.io).
2. Generate an API token in Settings → API Tokens.
3. Add it as `GITNEXUS_TOKEN` repo secret.
4. Add the workflow file above.

## Inputs

| Input        | Default                     | Purpose                          |
| ------------ | --------------------------- | -------------------------------- |
| `token`      | required                    | GitNexus API token               |
| `hub-url`    | `https://hub.gitnexus.io`   | Hub base URL (self-hosted)       |
| `pr-comment` | `true`                      | Post results as PR comment       |

## Outputs

| Output             | Description                                       |
| ------------------ | ------------------------------------------------- |
| `checks-json`      | The full check suite as a JSON string             |
| `summary-markdown` | The Markdown summary that would be posted to PR   |

## Notes

- The action requires `actions/checkout@v4` with `fetch-depth: 0` so it can build a complete `git bundle` of the PR head.
- The action uses `GITHUB_TOKEN` (provided automatically by GitHub Actions) to post or update the PR comment. Make sure the workflow has `pull-requests: write` permission.
- The PR comment is idempotent — re-running on the same PR updates the existing comment instead of creating a new one (matched via an HTML marker).
