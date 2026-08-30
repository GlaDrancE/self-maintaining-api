// Fake upstream API. Serves whichever spec version ACTIVE names, and behaves accordingly.
// Flip versions with: echo v2 > demo/petstore/ACTIVE   (no restart needed)
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readText } from '../../src/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VERSIONS = readdirSync(here)
  .filter((f) => /^openapi\..+\.json$/.test(f))
  .map((f) => f.slice('openapi.'.length, -'.json'.length));

function version() {
  const v = readText(join(here, 'ACTIVE')).trim().toLowerCase();
  if (!VERSIONS.includes(v)) {
    throw new Error(`ACTIVE contains ${JSON.stringify(v)}; expected one of: ${VERSIONS.join(', ')}`);
  }
  return v;
}

const PETS = [
  { id: 1, name: 'Rex', tag: 'dog', status: 'available', ownerId: 10 },
  { id: 2, name: 'Mia', tag: 'cat', status: 'pending', ownerId: 11 },
  { id: 3, name: 'Bo', tag: 'dog', status: 'sold', ownerId: 10 },
];
const OWNERS = [
  { id: 10, name: 'Ada' },
  { id: 11, name: 'Linus' },
];

// v2 removed `tag` from the Pet response schema.
const shape = (pet, v) => {
  const { ownerId, tag, ...rest } = pet;
  return v === 'v2' ? rest : { ...rest, tag };
};

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
  });

async function handle(req, res) {
  const v = version();
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(readFileSync(join(here, `openapi.${v}.json`), 'utf8'));
  }

  if (path === '/pets' && req.method === 'GET') {
    const allowed = v === 'v2' ? 'pageSize' : 'limit';
    const rejected = v === 'v2' ? 'limit' : 'pageSize';
    if (url.searchParams.has(rejected)) {
      return send(res, 400, { error: `unknown query parameter '${rejected}', use '${allowed}'` });
    }
    const n = Number(url.searchParams.get(allowed) ?? PETS.length);
    return send(res, 200, PETS.slice(0, n).map((p) => shape(p, v)));
  }

  if (path === '/pets' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: 'invalid json' });
    if (!body.name) return send(res, 400, { error: 'name is required' });
    if (v === 'v2' && body.ownerId === undefined) {
      return send(res, 400, { error: 'ownerId is required' });
    }
    const pet = { id: PETS.length + 1, status: 'available', ...body };
    return send(res, 201, shape(pet, v));
  }

  const petMatch = path.match(/^\/pets\/(\d+)$/);
  if (petMatch && req.method === 'GET') {
    const pet = PETS.find((p) => p.id === Number(petMatch[1]));
    return pet ? send(res, 200, shape(pet, v)) : send(res, 404, { error: 'not found' });
  }

  const ownerMatch = path.match(/^\/pets\/(\d+)\/owner$/);
  if (ownerMatch && req.method === 'GET') {
    if (v !== 'v2') return send(res, 404, { error: 'not found' });
    const pet = PETS.find((p) => p.id === Number(ownerMatch[1]));
    const owner = pet && OWNERS.find((o) => o.id === pet.ownerId);
    return owner ? send(res, 200, owner) : send(res, 404, { error: 'not found' });
  }

  send(res, 404, { error: 'not found' });
}

export function start(port = 8787) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: err.message }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await start();
  console.log(`petstore (${version()}) on http://localhost:${server.address().port}`);
}
