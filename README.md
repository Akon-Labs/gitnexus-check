<div align="center">

<img src=".github/assets/akonlabs-logo.png" alt="Akon Labs" width="120" />

# gitnexus-check

**A GitHub Action that posts a graph-aware review comment on every pull request.**

Built by [Akon Labs](https://akonlabs.com), powered by [GitNexus](https://github.com/abhigyanpatwari/GitNexus).

</div>

---

## What it is

`gitnexus-check` runs on every PR, asks the GitNexus Hub what the change touches and
who depends on it, then posts a single comment with the result. The comment updates
in place when you push more commits.

## What you get in the comment

- **Blast level** for the PR: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.
- **Blast radius**: direct, indirect, and transitive callers of the symbols you changed.
- **Symbol changes**: every function, class, or type the PR adds, modifies, or removes.
- **API surface**: routes, exports, and signatures that moved (the stuff your consumers see).
- **Architecture impact**: which modules of your codebase are touched, ranked by hit count.

## How to use it

```bash
npm install -g gitnexushub
gnx login {GNX_TOKEN}
gnx install-ci
```

That writes `.github/workflows/gitnexus.yml` for you with everything filled in.

Then add `GNX_TOKEN` as a repo secret in GitHub:

**Settings → Secrets and variables → Actions → New repository secret**

Generate the token from your profile at [akonlabs.com](https://akonlabs.com), paste it,
save. Open a PR and the comment shows up.

## Build and test (contributors)

```bash
npm install
npm run lint        # type-check
npm run test        # vitest, 81 tests
npm run build       # ncc bundle into dist/
npm run check-dist  # verify dist/ matches a fresh build
```

---

<div align="center">

<img src=".github/assets/akonlabs-logo.png" alt="Akon Labs" width="60" />

Made by [Akon Labs](https://akonlabs.com).
Powered by [GitNexus](https://github.com/abhigyanpatwari/GitNexus).

</div>
