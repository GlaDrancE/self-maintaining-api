// Materialise demo/demo-app from the tracked sources in demo/app.
//
// The demo app has to be its own git repo — `sma fix` branches cfg.repoPath, and
// pointing that at a directory inside this repo would put *this* checkout on an
// sma/ branch. A nested repo cannot be committed to the parent without becoming a
// submodule, so the sources live in demo/app and get copied here on demand.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'app');
const dest = join(here, 'demo-app');

if (existsSync(dest)) {
  if (!process.argv.includes('--force')) {
    console.log(`${dest} already exists — pass --force to recreate it from demo/app`);
    process.exit(0);
  }
  rmSync(dest, { recursive: true, force: true });
}

cpSync(src, dest, { recursive: true });

const git = (...args) => {
  const res = spawnSync('git', ['-C', dest, ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim()}`);
};

git('init', '-q', '-b', 'main');
git('add', '.');
// -c so the demo works on a machine with no global git identity configured.
git('-c', 'user.name=sma demo', '-c', 'user.email=demo@example.com', 'commit', '-qm', 'demo app at API v1');

console.log(`created ${dest} (git repo, one commit)`);
