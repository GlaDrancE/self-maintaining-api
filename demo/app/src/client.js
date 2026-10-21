export const BASE = process.env.PETSTORE_URL || 'http://localhost:8787';

export async function json(res) {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error ?? 'request failed'}`);
  return body;
}
