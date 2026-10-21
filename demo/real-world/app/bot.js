import { answer, listEngines } from './openai.js';

export async function faqBot(question, docs) {
  const engines = await listEngines();
  if (!engines.includes('curie')) throw new Error('curie unavailable');
  return answer(question, docs);
}
