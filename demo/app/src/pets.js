import { BASE, json } from './client.js';

export async function listPets(limit = 10) {
  const res = await fetch(`${BASE}/pets?limit=${limit}`);
  return json(res);
}

export async function getPet(id) {
  const res = await fetch(`${BASE}/pets/${id}`);
  return json(res);
}

export async function createPet(name, tag) {
  const res = await fetch(`${BASE}/pets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, tag }),
  });
  return json(res);
}

export function describePet(pet) {
  return `${pet.name} (${pet.tag})`;
}
