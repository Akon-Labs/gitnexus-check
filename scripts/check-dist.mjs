/**
 * @brief: Verify that the committed dist/ matches a fresh ncc build of src/.
 *
 * Cross-platform replacement for `rm -rf` + `ncc build` + `diff -r` shell
 * pipeline (which assumed Unix). Runs the ncc build into a temp dir,
 * byte-compares against dist/, then removes the temp dir. Exits 0 on
 * match, 1 on drift.
 *
 * @returns: void — process exits 0 on match, 1 on drift.
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';

const TMP = 'dist-check';
const SRC = 'dist';

function walk(root) {
  const out = [];
  function visit(dir, rel) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const next = rel ? posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) visit(abs, next);
      else out.push({ rel: next, abs });
    }
  }
  visit(root, '');
  return out;
}

function fail(msg) {
  console.error(`check-dist: ${msg}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

rmSync(TMP, { recursive: true, force: true });

try {
  execSync(`npx --no-install ncc build src/main.ts -o ${TMP} --license licenses.txt`, {
    stdio: 'inherit',
  });
} catch (err) {
  fail(`ncc build failed: ${err.message}`);
}

const distFiles = walk(SRC).sort((a, b) => a.rel.localeCompare(b.rel));
const tmpFiles = walk(TMP).sort((a, b) => a.rel.localeCompare(b.rel));

const distList = distFiles.map((f) => f.rel).join('\n');
const tmpList = tmpFiles.map((f) => f.rel).join('\n');
if (distList !== tmpList) {
  console.error('  committed:\n' + distList);
  console.error('  fresh:\n' + tmpList);
  fail('file lists differ between committed dist/ and fresh build');
}

for (let i = 0; i < distFiles.length; i++) {
  const a = readFileSync(distFiles[i].abs);
  const b = readFileSync(tmpFiles[i].abs);
  if (!a.equals(b)) fail(`${distFiles[i].rel} differs between committed dist/ and fresh build`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`check-dist: dist/ matches a fresh build (${distFiles.length} file(s) verified)`);
