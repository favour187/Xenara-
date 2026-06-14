// Xenara Neural Net — a real, from-scratch neural language model.
//
// Architecture (the Bengio 2003 neural LM — the direct ancestor of GPT/Claude):
//   input: the previous BLOCK characters
//   -> embedding lookup (each char -> EMB-dim vector)
//   -> concatenate -> hidden layer (tanh)
//   -> output layer -> softmax over the vocabulary
//
// Trained with cross-entropy loss and stochastic gradient descent using
// hand-written forward + backward passes (real backpropagation). No external
// ML libraries — pure JavaScript so it runs anywhere on CPU.

// ----------------------------- math helpers -----------------------------

function randn() {
  // Box-Muller transform for normal-distributed init.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function matrix(rows, cols, scale) {
  const m = new Float64Array(rows * cols);
  for (let i = 0; i < m.length; i++) m[i] = randn() * scale;
  return m;
}

// ----------------------------- the model -----------------------------

export class NeuralLM {
  constructor({ vocabSize, block = 8, embDim = 24, hidden = 128 }) {
    this.vocabSize = vocabSize;
    this.block = block;
    this.embDim = embDim;
    this.hidden = hidden;

    const inDim = block * embDim;
    // Parameters.
    this.C = matrix(vocabSize, embDim, 1.0); // embedding table
    this.W1 = matrix(inDim, hidden, Math.sqrt(2 / inDim)); // He init
    this.b1 = new Float64Array(hidden);
    this.W2 = matrix(hidden, vocabSize, Math.sqrt(1 / hidden));
    this.b2 = new Float64Array(vocabSize);
  }

  // Forward pass for a single example (array of `block` token ids).
  // Returns intermediates needed for backprop.
  forward(context) {
    const { embDim, hidden, vocabSize, block } = this;
    const inDim = block * embDim;

    // 1) Embed + concat.
    const x = new Float64Array(inDim);
    for (let p = 0; p < block; p++) {
      const tok = context[p];
      for (let d = 0; d < embDim; d++) x[p * embDim + d] = this.C[tok * embDim + d];
    }

    // 2) Hidden = tanh(x·W1 + b1).
    const hPre = new Float64Array(hidden);
    for (let j = 0; j < hidden; j++) {
      let s = this.b1[j];
      for (let i = 0; i < inDim; i++) s += x[i] * this.W1[i * hidden + j];
      hPre[j] = s;
    }
    const h = new Float64Array(hidden);
    for (let j = 0; j < hidden; j++) h[j] = Math.tanh(hPre[j]);

    // 3) Logits = h·W2 + b2.
    const logits = new Float64Array(vocabSize);
    for (let k = 0; k < vocabSize; k++) {
      let s = this.b2[k];
      for (let j = 0; j < hidden; j++) s += h[j] * this.W2[j * vocabSize + k];
      logits[k] = s;
    }

    // 4) Softmax.
    let max = -Infinity;
    for (let k = 0; k < vocabSize; k++) if (logits[k] > max) max = logits[k];
    let sum = 0;
    const probs = new Float64Array(vocabSize);
    for (let k = 0; k < vocabSize; k++) {
      probs[k] = Math.exp(logits[k] - max);
      sum += probs[k];
    }
    for (let k = 0; k < vocabSize; k++) probs[k] /= sum;

    return { x, h, probs, context };
  }

  // Backprop a single example and accumulate the loss. Updates params via SGD.
  trainStep(context, target, lr) {
    const { embDim, hidden, vocabSize, block } = this;
    const inDim = block * embDim;
    const { x, h, probs } = this.forward(context);

    // Cross-entropy loss.
    const loss = -Math.log(Math.max(probs[target], 1e-12));

    // dLogits = probs - onehot(target).
    const dLogits = probs; // reuse
    dLogits[target] -= 1;

    // Grad W2, b2 and dH.
    const dH = new Float64Array(hidden);
    for (let j = 0; j < hidden; j++) {
      const hj = h[j];
      let acc = 0;
      const base = j * vocabSize;
      for (let k = 0; k < vocabSize; k++) {
        const g = dLogits[k];
        this.W2[base + k] -= lr * g * hj;
        acc += g * this.W2[base + k];
      }
      dH[j] = acc;
    }
    for (let k = 0; k < vocabSize; k++) this.b2[k] -= lr * dLogits[k];

    // Through tanh: dHpre = dH * (1 - h^2).
    const dHpre = new Float64Array(hidden);
    for (let j = 0; j < hidden; j++) dHpre[j] = dH[j] * (1 - h[j] * h[j]);

    // Grad W1, b1 and dX.
    const dX = new Float64Array(inDim);
    for (let i = 0; i < inDim; i++) {
      const xi = x[i];
      let acc = 0;
      const base = i * hidden;
      for (let j = 0; j < hidden; j++) {
        const g = dHpre[j];
        acc += g * this.W1[base + j];
        this.W1[base + j] -= lr * g * xi;
      }
      dX[i] = acc;
    }
    for (let j = 0; j < hidden; j++) this.b1[j] -= lr * dHpre[j];

    // Grad embedding table (scatter dX back to the rows used).
    for (let p = 0; p < block; p++) {
      const tok = context[p];
      const ebase = tok * embDim;
      const xbase = p * embDim;
      for (let d = 0; d < embDim; d++) this.C[ebase + d] -= lr * dX[xbase + d];
    }

    return loss;
  }

  // Sample the next token id given a context, with temperature.
  sample(context, temperature = 1.0) {
    const { probs } = this.forward(context);
    if (temperature <= 0) {
      let best = 0;
      for (let k = 1; k < probs.length; k++) if (probs[k] > probs[best]) best = k;
      return best;
    }
    // Apply temperature by re-normalizing log-probs.
    const adj = new Float64Array(probs.length);
    let sum = 0;
    for (let k = 0; k < probs.length; k++) {
      adj[k] = Math.pow(probs[k], 1 / temperature);
      sum += adj[k];
    }
    let r = Math.random() * sum;
    for (let k = 0; k < probs.length; k++) {
      r -= adj[k];
      if (r <= 0) return k;
    }
    return probs.length - 1;
  }

  // ---- serialization ----
  toJSON() {
    return {
      vocabSize: this.vocabSize,
      block: this.block,
      embDim: this.embDim,
      hidden: this.hidden,
      C: Array.from(this.C),
      W1: Array.from(this.W1),
      b1: Array.from(this.b1),
      W2: Array.from(this.W2),
      b2: Array.from(this.b2),
    };
  }

  static fromJSON(o) {
    const m = new NeuralLM({
      vocabSize: o.vocabSize,
      block: o.block,
      embDim: o.embDim,
      hidden: o.hidden,
    });
    m.C = Float64Array.from(o.C);
    m.W1 = Float64Array.from(o.W1);
    m.b1 = Float64Array.from(o.b1);
    m.W2 = Float64Array.from(o.W2);
    m.b2 = Float64Array.from(o.b2);
    return m;
  }
}
