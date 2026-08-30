// All state lives in .sma/ as plain JSON. Inspectable with `cat`, diffable with git.
// ponytail: flat files, fine at this scale; move to SQLite if you ever want cross-run queries.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const CONFIG_NAME = 'watch.yaml';

// watch.yaml marks the project root the way package.json does for npm. Walk up from
// the cwd so `sma check` behaves the same from a subdirectory — without this, running
// from src/ silently starts a fresh project against an empty .sma/ and reports
// "baseline captured" forever.
function findConfig(start = process.cwd()) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_NAME);
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return null;
  }
}

function flagValue(name, argv = process.argv) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

// --config wins, then SMA_CONFIG, then the upward search. Finding nothing is not an
// error here: `sma init`, `sma doctor` and `sma help` all have to run before a config
// exists. loadConfig() is where the absence becomes a message.
export const CONFIG = resolve(
  flagValue('--config') ?? process.env.SMA_CONFIG ?? findConfig() ?? join(process.cwd(), CONFIG_NAME),
);
export const ROOT = dirname(CONFIG);
export const SMA = join(ROOT, '.sma');

export const hasConfig = () => existsSync(CONFIG);

// Read a text file whatever encoding it landed in. On Windows this matters more
// than it should: PowerShell's `echo x > file` writes UTF-16LE with a BOM, and a
// plain utf8 read turns that into null-byte soup.
export function readText(file) {
  const buf = readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().subarray(2).toString('utf16le');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

export function loadConfig(file = CONFIG) {
  if (!existsSync(file)) {
    throw new Error(`no ${CONFIG_NAME} in ${process.cwd()} or any parent directory — run \`sma init\``);
  }
  const cfg = parseYaml(readText(file));
  if (!cfg?.repo) throw new Error(`${CONFIG_NAME}: \`repo\` is required`);
  if (!Array.isArray(cfg.apis) || !cfg.apis.length) throw new Error(`${CONFIG_NAME}: \`apis\` is empty`);

  const seen = new Set();
  for (const api of cfg.apis) {
    if (!api.name || !api.spec) throw new Error(`${CONFIG_NAME}: each api needs \`name\` and \`spec\``);
    // The name becomes a filename under .sma/specs/, so it is a trust boundary:
    // `../../something` in a config file must not decide where we write.
    if (!/^[a-zA-Z0-9._-]+$/.test(api.name)) {
      throw new Error(`${CONFIG_NAME}: api name "${api.name}" must be letters, digits, dot, dash or underscore`);
    }
    if (seen.has(api.name)) throw new Error(`${CONFIG_NAME}: duplicate api name "${api.name}"`);
    seen.add(api.name);
  }

  // Relative to the config file, not the cwd. Otherwise `repo: ./app` means a
  // different directory depending on where you happened to be standing.
  cfg.configPath = file;
  cfg.repoPath = resolve(dirname(file), cfg.repo);
  if (!existsSync(cfg.repoPath)) throw new Error(`repo not found: ${cfg.repoPath}`);
  return cfg;
}

export function read(rel, fallback = null) {
  const file = join(SMA, rel);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function write(rel, data) {
  const file = join(SMA, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

export function writeText(rel, text) {
  const file = join(SMA, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

export function latestChanges() {
  const dir = join(SMA, 'changes');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.length ? read(join('changes', files.at(-1))) : null;
}

export function appendRun(entry) {
  const runs = read('runs.json', []);
  runs.push(entry);
  write('runs.json', runs);
}

// Exported for the test; nothing else should need to walk for the config itself.
export { findConfig };
