import { BASE, json } from './client.js';
import { describePet } from './pets.js';

// Second call site for GET /pets/{id} — proves the impact mapper finds every usage,
// not just the first one.
export async function petSummary(id) {
  const res = await fetch(`${BASE}/pets/${id}`);
  const pet = await json(res);
  return `#${pet.id} ${describePet(pet)} [${pet.status}]`;
}
