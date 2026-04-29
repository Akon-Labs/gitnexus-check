import * as exec from '@actions/exec';

export async function createBundle(opts: {
  ref: string;
  outPath: string;
  cwd: string;
}): Promise<void> {
  await exec.exec('git', ['bundle', 'create', opts.outPath, opts.ref], { cwd: opts.cwd });
}
