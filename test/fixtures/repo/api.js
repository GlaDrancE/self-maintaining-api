const BASE = 'https://api.example.com';

export async function listWidgets(limit) {
  return fetch(`${BASE}/widgets?limit=${limit}`).then((r) => r.json());
}

export async function getWidget(id) {
  return fetch(`${BASE}/widgets/${id}`).then((r) => r.json());
}

export async function createWidget(name) {
  return fetch(`${BASE}/widgets`, { method: 'POST', body: JSON.stringify({ name }) });
}

// Not a watched host — must not be picked up.
export async function unrelated() {
  return fetch('https://example.org/health');
}

// URL is computed at runtime — must land in `unresolved`, not be silently dropped.
export async function dynamic(path) {
  return fetch(path);
}
