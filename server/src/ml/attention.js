// Xenara Mini-Transformer — a real single-head self-attention language model
// trained from scratch with hand-written forward + backward passes.
//
// Architecture (a minimal GPT-style block):
//   tokens -> token embedding + positional embedding
//   -> single-head causal self-attention (Q,K,V) with residual
//   -> position-wise feed-forward (tanh) with residual
//   -> output projection -> softmax over vocab
//
// Pure JS, CPU-only, no libraries. This is intentionally compact so it trains
// in seconds, but it adds genuine attention (the core mechanism behind modern
// LLMs) on top of the simpler Bengio MLP in nn.js.

function randn() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function mat(r, c, s) {
  const m = new Float64Array(r * c);
  for (let i = 0; i < m.length; i++) m[i] = randn() * s;
  return m;
}

export class MiniTransformer {
  constructor({ vocabSize, block = 16, dModel = 48, dff = 96 }) {
    this.vocabSize = vocabSize;
    this.block = block;
    this.d = dModel;
    this.dff = dff;
    const d = dModel;
    this.tok = mat(vocabSize, d, 0.08); // token embedding
    this.pos = mat(block, d, 0.08); // positional embedding
    // attention projections
    this.Wq = mat(d, d, Math.sqrt(1 / d));
    this.Wk = mat(d, d, Math.sqrt(1 / d));
    this.Wv = mat(d, d, Math.sqrt(1 / d));
    this.Wo = mat(d, d, Math.sqrt(1 / d));
    // feed-forward
    this.W1 = mat(d, dff, Math.sqrt(2 / d));
    this.b1 = new Float64Array(dff);
    this.W2 = mat(dff, d, Math.sqrt(1 / dff));
    this.b2 = new Float64Array(d);
    // output head
    this.Wout = mat(d, vocabSize, Math.sqrt(1 / d));
    this.bout = new Float64Array(vocabSize);
    this.scale = 1 / Math.sqrt(d);
  }

  // Forward over a context window. Returns probs for the LAST position plus
  // caches for backprop. Predicts the next token after the window.
  forward(context) {
    const { d, block, dff, vocabSize } = this;
    const T = context.length; // <= block

    // Embeddings: X[t] = tok[context[t]] + pos[t]
    const X = [];
    for (let t = 0; t < T; t++) {
      const row = new Float64Array(d);
      const tb = context[t] * d;
      const pb = t * d;
      for (let i = 0; i < d; i++) row[i] = this.tok[tb + i] + this.pos[pb + i];
      X.push(row);
    }

    // Q,K,V projections.
    const Q = [];
    const K = [];
    const V = [];
    for (let t = 0; t < T; t++) {
      const q = new Float64Array(d);
      const k = new Float64Array(d);
      const v = new Float64Array(d);
      for (let j = 0; j < d; j++) {
        let sq = 0;
        let sk = 0;
        let sv = 0;
        for (let i = 0; i < d; i++) {
          const x = X[t][i];
          sq += x * this.Wq[i * d + j];
          sk += x * this.Wk[i * d + j];
          sv += x * this.Wv[i * d + j];
        }
        q[j] = sq;
        k[j] = sk;
        v[j] = sv;
      }
      Q.push(q);
      K.push(k);
      V.push(v);
    }

    // Causal self-attention — we only need the last position's output for LM.
    const last = T - 1;
    const scores = new Float64Array(T);
    let maxS = -Infinity;
    for (let t = 0; t <= last; t++) {
      let s = 0;
      for (let i = 0; i < d; i++) s += Q[last][i] * K[t][i];
      s *= this.scale;
      scores[t] = s;
      if (s > maxS) maxS = s;
    }
    let sum = 0;
    const attn = new Float64Array(T);
    for (let t = 0; t <= last; t++) {
      attn[t] = Math.exp(scores[t] - maxS);
      sum += attn[t];
    }
    for (let t = 0; t <= last; t++) attn[t] /= sum;

    // Context vector = sum attn[t] * V[t]
    const ctxVec = new Float64Array(d);
    for (let t = 0; t <= last; t++) {
      const a = attn[t];
      for (let i = 0; i < d; i++) ctxVec[i] += a * V[t][i];
    }

    // Output projection + residual with X[last]. Clamp the residual stream to
    // keep activations bounded (stand-in for layer norm; keeps training stable).
    const CLAMP = 12;
    const ao = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let s = 0;
      for (let i = 0; i < d; i++) s += ctxVec[i] * this.Wo[i * d + j];
      let v = s + X[last][j];
      if (v > CLAMP) v = CLAMP;
      else if (v < -CLAMP) v = -CLAMP;
      ao[j] = v;
    }

    // Feed-forward (tanh) + residual.
    const hPre = new Float64Array(dff);
    for (let j = 0; j < dff; j++) {
      let s = this.b1[j];
      for (let i = 0; i < d; i++) s += ao[i] * this.W1[i * dff + j];
      hPre[j] = s;
    }
    const h = new Float64Array(dff);
    for (let j = 0; j < dff; j++) h[j] = Math.tanh(hPre[j]);

    const CLAMP2 = 12;
    const ff = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let s = this.b2[j];
      for (let i = 0; i < dff; i++) s += h[i] * this.W2[i * d + j];
      let v = s + ao[j]; // residual
      if (v > CLAMP2) v = CLAMP2;
      else if (v < -CLAMP2) v = -CLAMP2;
      ff[j] = v;
    }

    // Logits + softmax.
    const logits = new Float64Array(vocabSize);
    for (let k = 0; k < vocabSize; k++) {
      let s = this.bout[k];
      for (let i = 0; i < d; i++) s += ff[i] * this.Wout[i * vocabSize + k];
      logits[k] = s;
    }
    let mx = -Infinity;
    for (let k = 0; k < vocabSize; k++) if (logits[k] > mx) mx = logits[k];
    let zs = 0;
    const probs = new Float64Array(vocabSize);
    for (let k = 0; k < vocabSize; k++) {
      probs[k] = Math.exp(logits[k] - mx);
      zs += probs[k];
    }
    for (let k = 0; k < vocabSize; k++) probs[k] /= zs;

    return { X, Q, K, V, attn, ctxVec, ao, h, ff, probs, last, T };
  }

  // Train one example with full backprop through FF, output proj, and attention.
  trainStep(context, target, lr) {
    const { d, dff, vocabSize } = this;
    const c = this.forward(context);
    const { X, Q, K, V, attn, ctxVec, ao, h, ff, probs, last, T } = c;

    const loss = -Math.log(Math.max(probs[target], 1e-12));

    // dLogits with gradient clipping to keep training stable (no layer norm).
    const CLIP = 5;
    const dLogits = probs;
    dLogits[target] -= 1;
    for (let k = 0; k < vocabSize; k++) {
      if (dLogits[k] > CLIP) dLogits[k] = CLIP;
      else if (dLogits[k] < -CLIP) dLogits[k] = -CLIP;
    }

    // Output head grads + dff.
    const dff_ = new Float64Array(d);
    for (let i = 0; i < d; i++) {
      let acc = 0;
      const base = i * vocabSize;
      const fi = ff[i];
      for (let k = 0; k < vocabSize; k++) {
        const g = dLogits[k];
        this.Wout[base + k] -= lr * g * fi;
        acc += g * this.Wout[base + k];
      }
      dff_[i] = acc;
    }
    for (let k = 0; k < vocabSize; k++) this.bout[k] -= lr * dLogits[k];

    // FF residual: ff = W2·h + b2 + ao  => grad to ao passes through (+1).
    const dao = new Float64Array(d);
    for (let i = 0; i < d; i++) dao[i] += dff_[i]; // residual path

    // through W2
    const dh = new Float64Array(dff);
    for (let i = 0; i < dff; i++) {
      let acc = 0;
      const base = i * d;
      const hi = h[i];
      for (let j = 0; j < d; j++) {
        const g = dff_[j];
        this.W2[base + j] -= lr * g * hi;
        acc += g * this.W2[base + j];
      }
      dh[i] = acc;
    }
    for (let j = 0; j < d; j++) this.b2[j] -= lr * dff_[j];

    // through tanh + W1 -> dao
    const dhPre = new Float64Array(dff);
    for (let i = 0; i < dff; i++) dhPre[i] = dh[i] * (1 - h[i] * h[i]);
    for (let i = 0; i < d; i++) {
      let acc = 0;
      const aoi = ao[i];
      for (let j = 0; j < dff; j++) {
        const g = dhPre[j];
        this.W1[i * dff + j] -= lr * g * aoi;
        acc += g * this.W1[i * dff + j];
      }
      dao[i] += acc;
    }
    for (let j = 0; j < dff; j++) this.b1[j] -= lr * dhPre[j];

    this._clipVec(dao);
    // ao = Wo·ctxVec + X[last]  => residual to X[last], and grad to ctxVec.
    const dctx = new Float64Array(d);
    const dXlast = new Float64Array(d);
    for (let i = 0; i < d; i++) dXlast[i] += dao[i]; // residual
    for (let i = 0; i < d; i++) {
      let acc = 0;
      const ci = ctxVec[i];
      for (let j = 0; j < d; j++) {
        const g = dao[j];
        this.Wo[i * d + j] -= lr * g * ci;
        acc += g * this.Wo[i * d + j];
      }
      dctx[i] = acc;
    }

    // ctxVec = sum attn[t]*V[t]. Grad to V and to attn weights.
    const dattn = new Float64Array(T);
    const dV = [];
    for (let t = 0; t < T; t++) dV.push(new Float64Array(d));
    for (let t = 0; t <= last; t++) {
      let da = 0;
      for (let i = 0; i < d; i++) {
        dV[t][i] += attn[t] * dctx[i];
        da += dctx[i] * V[t][i];
      }
      dattn[t] = da;
    }

    // softmax backward for attention.
    let dot = 0;
    for (let t = 0; t <= last; t++) dot += dattn[t] * attn[t];
    const dscores = new Float64Array(T);
    for (let t = 0; t <= last; t++) dscores[t] = attn[t] * (dattn[t] - dot) * this.scale;

    // scores[t] = Q[last]·K[t]. Grads to Q[last] and K[t].
    const dQlast = new Float64Array(d);
    const dK = [];
    for (let t = 0; t < T; t++) dK.push(new Float64Array(d));
    for (let t = 0; t <= last; t++) {
      const ds = dscores[t];
      for (let i = 0; i < d; i++) {
        dQlast[i] += ds * K[t][i];
        dK[t][i] += ds * Q[last][i];
      }
    }

    // Backprop Q,K,V projections into dX, and update Wq,Wk,Wv.
    const dX = [];
    for (let t = 0; t < T; t++) dX.push(new Float64Array(d));

    // V projections for all t.
    for (let t = 0; t <= last; t++) {
      for (let j = 0; j < d; j++) {
        const g = dV[t][j];
        if (g === 0) continue;
        for (let i = 0; i < d; i++) {
          this.Wv[i * d + j] -= lr * g * X[t][i];
          dX[t][i] += g * this.Wv[i * d + j];
        }
      }
    }
    // K projections.
    for (let t = 0; t <= last; t++) {
      for (let j = 0; j < d; j++) {
        const g = dK[t][j];
        if (g === 0) continue;
        for (let i = 0; i < d; i++) {
          this.Wk[i * d + j] -= lr * g * X[t][i];
          dX[t][i] += g * this.Wk[i * d + j];
        }
      }
    }
    // Q projection (only last).
    for (let j = 0; j < d; j++) {
      const g = dQlast[j];
      if (g === 0) continue;
      for (let i = 0; i < d; i++) {
        this.Wq[i * d + j] -= lr * g * X[last][i];
        dX[last][i] += g * this.Wq[i * d + j];
      }
    }

    // Add residual grad to last position.
    for (let i = 0; i < d; i++) dX[last][i] += dXlast[i];

    // Embedding grads (clipped).
    for (let t = 0; t < T; t++) {
      this._clipVec(dX[t]);
      const tb = context[t] * d;
      const pb = t * d;
      for (let i = 0; i < d; i++) {
        const g = dX[t][i];
        this.tok[tb + i] -= lr * g;
        this.pos[pb + i] -= lr * g;
      }
    }

    return loss;
  }

  _clipVec(v, c = 5) {
    for (let i = 0; i < v.length; i++) {
      if (v[i] > c) v[i] = c;
      else if (v[i] < -c) v[i] = -c;
      else if (!Number.isFinite(v[i])) v[i] = 0;
    }
    return v;
  }

  sample(context, temperature = 0.8) {
    const { probs } = this.forward(context);
    if (temperature <= 0) {
      let best = 0;
      for (let k = 1; k < probs.length; k++) if (probs[k] > probs[best]) best = k;
      return best;
    }
    const adj = new Float64Array(probs.length);
    let s = 0;
    for (let k = 0; k < probs.length; k++) {
      adj[k] = Math.pow(probs[k], 1 / temperature);
      s += adj[k];
    }
    let r = Math.random() * s;
    for (let k = 0; k < probs.length; k++) {
      r -= adj[k];
      if (r <= 0) return k;
    }
    return probs.length - 1;
  }

  toJSON() {
    const f = (a) => Array.from(a);
    return {
      type: 'transformer',
      vocabSize: this.vocabSize,
      block: this.block,
      dModel: this.d,
      dff: this.dff,
      tok: f(this.tok), pos: f(this.pos),
      Wq: f(this.Wq), Wk: f(this.Wk), Wv: f(this.Wv), Wo: f(this.Wo),
      W1: f(this.W1), b1: f(this.b1), W2: f(this.W2), b2: f(this.b2),
      Wout: f(this.Wout), bout: f(this.bout),
    };
  }

  static fromJSON(o) {
    const m = new MiniTransformer({ vocabSize: o.vocabSize, block: o.block, dModel: o.dModel, dff: o.dff });
    const F = (a) => Float64Array.from(a);
    m.tok = F(o.tok); m.pos = F(o.pos);
    m.Wq = F(o.Wq); m.Wk = F(o.Wk); m.Wv = F(o.Wv); m.Wo = F(o.Wo);
    m.W1 = F(o.W1); m.b1 = F(o.b1); m.W2 = F(o.W2); m.b2 = F(o.b2);
    m.Wout = F(o.Wout); m.bout = F(o.bout);
    return m;
  }
}
