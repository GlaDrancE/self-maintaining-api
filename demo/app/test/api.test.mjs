import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../petstore/server.mjs';
import { listPets, getPet, createPet, describePet } from '../src/pets.js';
import { petSummary } from '../src/report.js';

let server;

before(async () => {
  // Reuse an already-running petstore if there is one.
  server = await start().catch((e) => (e.code === 'EADDRINUSE' ? null : Promise.reject(e)));
});
after(() => server?.close());

test('listPets returns pets', async () => {
  const pets = await listPets(2);
  assert.equal(pets.length, 2);
  assert.equal(pets[0].name, 'Rex');
});

test('getPet returns a pet with a tag', async () => {
  const pet = await getPet(1);
  assert.equal(pet.name, 'Rex');
  assert.equal(describePet(pet), 'Rex (dog)');
});

test('petSummary formats a pet', async () => {
  assert.equal(await petSummary(2), '#2 Mia (cat) [pending]');
});

test('createPet creates a pet', async () => {
  const pet = await createPet('Nix', 'ferret');
  assert.equal(pet.name, 'Nix');
});
