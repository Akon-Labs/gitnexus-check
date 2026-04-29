import * as exec from '@actions/exec';

/**
 * Create a git bundle containing the full history reachable from the
 * given ref. The Hub unpacks this on the receiving end and re-indexes.
 *
 * Implementation detail: `git bundle create <out> <bare-sha>` fails
 * with "Refusing to create empty bundle" because bundles need a
 * ref-like rev to anchor the included commits. We pass `--all` so the
 * bundle includes every ref the runner has after `actions/checkout@v4
 * with fetch-depth: 0`. The Hub picks the right ref by SHA on its end.
 *
 * `opts.ref` is kept in the signature for caller documentation / future
 * use (e.g. limiting the bundle to that ref's history) but isn't used
 * by `--all` directly.
 */
export async function createBundle(opts: {
  ref: string;
  outPath: string;
  cwd: string;
}): Promise<void> {
  await exec.exec('git', ['bundle', 'create', opts.outPath, '--all'], { cwd: opts.cwd });
}
