// A small app written against OpenAI's API as it was in early 2023.
const BASE = 'https://api.openai.com/v1';
const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' };

export async function listEngines() {
  const res = await fetch(`${BASE}/engines`, { headers });
  return (await res.json()).data.map((e) => e.id);
}

export async function answer(question, documents) {
  const res = await fetch(`${BASE}/answers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'curie', question, documents, examples_context: '', examples: [] }),
  });
  return (await res.json()).answers[0];
}

export async function complete(prompt) {
  const res = await fetch(`${BASE}/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'text-davinci-003', prompt }),
  });
  return (await res.json()).choices[0].text;
}

export async function listModels() {
  const res = await fetch(`${BASE}/models`, { headers });
  return (await res.json()).data;
}
