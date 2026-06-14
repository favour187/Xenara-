// Character-level tokenizer for the Xenara neural LM.
// Builds a vocabulary from the training corpus and maps chars <-> ids.

export class CharTokenizer {
  constructor(chars) {
    this.chars = chars;
    this.stoi = new Map();
    this.itos = new Map();
    chars.forEach((c, i) => {
      this.stoi.set(c, i);
      this.itos.set(i, c);
    });
  }

  static fromText(text) {
    const set = new Set(text.split(''));
    const chars = Array.from(set).sort();
    return new CharTokenizer(chars);
  }

  get vocabSize() {
    return this.chars.length;
  }

  encode(text) {
    const ids = [];
    for (const ch of text) {
      const id = this.stoi.get(ch);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  decode(ids) {
    return ids.map((i) => this.itos.get(i) ?? '').join('');
  }

  toJSON() {
    return { chars: this.chars };
  }

  static fromJSON(o) {
    return new CharTokenizer(o.chars);
  }
}
