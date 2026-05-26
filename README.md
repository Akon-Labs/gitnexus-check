<div align="center">

<img src=".github/assets/akonlabs-logo.png" alt="Akon Labs" width="120" />

# gitnexus-check

**A GitHub Action that posts a graph-aware review comment on every pull request.**

</div>

---


## What it is

`gitnexus-check` runs on every PR, asks the GitNexus Hub what the change touches and
who depends on it, then posts a single comment with the result. The comment updates
in place when you push more commits.

## What you get in the comment

- **Verdict headline**: the blast level plus a one-line rationale (dependent-symbol count,
  modules touched, flows affected, and a "review carefully" note when the level is high).
- **Blast level** for the PR: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.
- **Architecture impact**: which modules of your codebase are touched, ranked by hit count.
- **Affected flows**: the execution flows (processes) the change reaches, ranked by hits.
- **Blast radius**: direct, indirect, and transitive callers of the symbols you changed.
- **Symbol changes**: every function, class, or type the PR adds, modifies, or removes.
- **API surface**: routes, exports, and signatures that moved (the stuff your consumers see).
- **Changed files**: every file in the diff with its status (added / modified / removed).
- **File risk**: non-graph files (migrations, CI, infra, config) flagged by risk category.

Sections render only when they have data — a docs-only PR won't show a Blast Radius table.

GNX_TOKEN can be Acquired [here](https://app.akonlabs.com/)

## How to use it

```bash
npm install -g gitnexushub
gnx connect {GITNEXUS_TOKEN} --editor {editor}
```

--editor parameters
Cursor
```bash
gnx connect {GITNEXUS_TOKEN} --editor cursor
```

Windsurf
```bash
gnx connect {GITNEXUS_TOKEN} --editor windsurf
```

Claude Code
```bash
gnx connect {GITNEXUS_TOKEN} --editor claude-code
```

OpenCode
```bash
gnx connect {GITNEXUS_TOKEN} --editor opencode
```


## To get started
1) Create a gitnexus.yml file in your repo,
2) Ensure the repo is indexed on either app.akonlabs.com or via the gitnexushub cli -> [Find out more here](https://akonlabs.com)
3) Create PR on the branch specified in the list in `.github/workflows/gitnexus.yml`

## Example `.github/workflows/gitnexus.yml`

```yaml
# managed by gitnexus-cli
name: GitNexus

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: Akon-Labs/gitnexus-check@release
        with:
          hub-url: https://gitnexus-enterprise-production.up.railway.app
          token: ${{ secrets.GITNEXUS_TOKEN }}
```

Use that for an example in your`.github/workflows/gitnexus.yml` and add to the branch you want to have the action.

Then add `GITNEXUS_TOKEN` as a repo secret in GitHub:

**Settings → Secrets and variables → Actions → New repository secret**

Generate the token from your profile at [akonlabs.com](https://akonlabs.com), paste it,
save. Open a PR and the comment shows up.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `hub-url` | yes | — | GitNexus Hub base URL (e.g. `https://app.akonlabs.com`). |
| `token` | yes | — | GitNexus CI token (`gnx_…`). Store as a repo secret and pass it in. |
| `github-token` | no | `${{ github.token }}` | Token used to post the PR comment. |
| `fail-on-blast-level` | no | `''` (off) | Optional merge gate. See below. |

## Outputs

| Output | Description |
|--------|-------------|
| `comment-id` | The GitHub comment id created or updated. |
| `blast-level` | The PR blast level: `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL`. |
| `gate-decision` | `pass` \| `fail` \| `neutral`. `neutral` means advisory (no gate set). |

## Optional: the merge gate (`fail-on-blast-level`)

By default the action is **advisory** — it always posts the comment and the check stays
green. Set `fail-on-blast-level` to turn it into a **gate** that fails the workflow when
the PR's blast level meets or exceeds your threshold. The comment is always posted first,
so a red check always has an explanation attached.

```yaml
- uses: Akon-Labs/gitnexus-check@release
  with:
    hub-url: https://gitnexus-enterprise-production.up.railway.app
    token: ${{ secrets.GITNEXUS_TOKEN }}
    fail-on-blast-level: CRITICAL   # block only on CRITICAL; omit for advisory
```

Threshold is **meets-or-exceeds**: `fail-on-blast-level: HIGH` fails on both `HIGH` and
`CRITICAL`. Accepted values are `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` (case-sensitive); an
empty value (the default) keeps the action advisory.

To make the gate actually block merges, mark the GitNexus check as **required** in your
branch protection rules (**Settings → Branches → Branch protection rules**).


<div align="center">

<img src=".github/assets/akonlabs-logo.png" alt="Akon Labs" width="60" />

Made by [Akon Labs](https://akonlabs.com).
Powered by [GitNexus](https://github.com/abhigyanpatwari/GitNexus).

</div>
