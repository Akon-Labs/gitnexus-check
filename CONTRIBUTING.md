# Contributing

Thanks for wanting to contribute to gitnexus-check.

## Reporting issues

Open an issue before you start work. Use the right type and fill in every field.

### Bug report template

```md
### What you're experiencing
Describe the issue.

### What you did
The steps or actions you took.

### How to recreate it
The exact flow to reproduce the same issue.
```

### Feature request template

```md
### Problem
What can't you do today.

### Proposal
What you want the action to do.

### Alternatives
Anything you tried or considered.

### Scope
Is this a config input, a comment section, a gate behavior, or something else.
```

## Making changes

1. Fork this repo.
2. Create a branch in your fork off `dev`. Name it `fix/<slug>` or `feat/<slug>`.
3. Make your change. Keep it focused on one thing.
4. Make sure everything passes:
   ```bash
   npm ci
   npm run lint
   npm test
   npm run build
   npm run check-dist
   ```
5. Open a pull request from your fork into the `dev` branch.

### Standards

- One change per PR. Split unrelated work.
- Every PR references an issue. Open one first if it doesn't exist.
- Lint, tests, build, and `check-dist` must pass. `check-dist` failing means you didn't rebuild `dist/`, run `npm run build` and commit it.
- Add or update tests for any behavior change.
- Don't commit secrets, tokens, or `.env`.
- Commit messages: `type: short description` (`fix:`, `feat:`, `docs:`, `chore:`, `test:`, `refactor:`).

### Pull request template

```md
### What
What this PR changes.

### Why
The reason. Link the issue: Closes #123.

### Type
- [ ] fix
- [ ] feat
- [ ] docs
- [ ] chore / refactor / test

### Checklist
- [ ] Targets `dev`
- [ ] One focused change
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run build` run and `dist/` committed
- [ ] `npm run check-dist` passes
- [ ] Tests added or updated
- [ ] No secrets committed

### Testing
How you verified the change.
```

## Review

A maintainer reviews your pull request and may ask for changes before merging. Once
merged into `dev` then `staging`, it gets folded into a future release.

## License

By contributing, you agree that your contributions will be licensed under the MIT
license used by this project.
