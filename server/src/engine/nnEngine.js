// Adapter that lets Xenara's own trained-from-scratch neural model power chat.

import { generateStream, isTrained } from '../ml/trainer.js';

export function nnAvailable() {
  return isTrained();
}

// Stream a reply from the neural model, seeded by the latest user message.
export async function* nnStream(history) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const prompt = (lastUser?.content || '').slice(-120);
  yield* generateStream(prompt, { maxTokens: 260, temperature: 0.7 });
}
