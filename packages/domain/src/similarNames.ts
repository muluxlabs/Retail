/**
 * Finding items that are probably the same item under a slightly different
 * name: "Suger 2kg" for "Sugar 2kg", "Coca-Cola 500 ml" for "Coca Cola 500ml".
 *
 * Names are first put in a standard form (case, punctuation, spacing, units
 * written one way), then compared by their three-letter pieces. Sizes are
 * facts, not spelling: "Sugar 1kg" and "Sugar 2kg" are different items, so
 * names whose numbers differ are never called look-alikes.
 *
 * An index over the existing names keeps this fast when a file of thousands
 * of items is checked against a master of tens of thousands.
 */

const UNIT: [RegExp, string][] = [
  [/\b(kilograms?|kilos?|kgs)\b/g, 'kg'],
  [/\b(grams?|grammes?|gms?|grm)\b/g, 'g'],
  [/\b(litres?|liters?|ltrs?|lt)\b/g, 'l'],
  [/\b(millilitres?|milliliters?|mls)\b/g, 'ml'],
  [/\b(pieces?|pcs)\b/g, 'pc'],
];

/** The standard form of a name: what two spellings of the same item have in common. */
export function normaliseName(name: string): string {
  let s = name.toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '');
  s = s.replace(/[^a-z0-9.]+/g, ' ');
  for (const [re, to] of UNIT) s = s.replace(re, to);
  // "2 kg" -> "2kg", "500 ml" -> "500ml", "x 12" -> "x12"
  s = s.replace(/(\d)\s+(kg|g|l|ml|pc|x)\b/g, '$1$2').replace(/\bx\s+(\d)/g, 'x$1');
  // "2.0kg" -> "2kg", "0.5l" stays
  s = s.replace(/(\d+)\.0+(?!\d)/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

/** The numbers in a name (sizes, counts), which must agree for two names to be the same item. */
function numbers(norm: string): string {
  return (norm.match(/\d+(\.\d+)?/g) ?? []).sort().join('|');
}

function trigrams(norm: string): Set<string> {
  const s = `  ${norm} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

/** Edits (insert, delete, replace, or swap two neighbouring letters) to turn one string into the other. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

function dice(ta: Set<string>, tb: Set<string>): number {
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return (2 * common) / (ta.size + tb.size);
}

/** Two measures, the kinder one wins: shared three-letter pieces, and few edits relative to length. */
function score(na: string, ta: Set<string>, nb: string, tb: Set<string>): number {
  const byPieces = dice(ta, tb);
  const byEdits = 1 - editDistance(na, nb) / Math.max(na.length, nb.length);
  return Math.max(byPieces, byEdits);
}

/** How alike two names are, from 0 to 1 (1 = the same once standardised). Different sizes score 0. */
export function nameSimilarity(a: string, b: string): number {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (na === nb) return 1;
  if (numbers(na) !== numbers(nb)) return 0;
  return score(na, trigrams(na), nb, trigrams(nb));
}

/** Above this, a name is shown as a probable duplicate and needs confirming. */
export const LOOK_ALIKE = 0.8;

export interface NamedItem {
  id: string;
  name: string;
  sku: string | null;
}

export interface NameIndex<T extends NamedItem> {
  add(item: T): void;
  /** Items whose standardised name is identical. */
  same(name: string): T[];
  /** Items that look alike (not identical), best first. */
  alike(name: string, limit?: number): { item: T; score: number }[];
}

export function nameIndex<T extends NamedItem>(items: readonly T[] = []): NameIndex<T> {
  const byNorm = new Map<string, T[]>();
  const byTrigram = new Map<string, number[]>();
  const all: { item: T; norm: string; nums: string; grams: Set<string> }[] = [];

  const add = (item: T) => {
    const norm = normaliseName(item.name);
    const grams = trigrams(norm);
    const i = all.length;
    all.push({ item, norm, nums: numbers(norm), grams });
    byNorm.set(norm, [...(byNorm.get(norm) ?? []), item]);
    for (const g of grams) {
      const list = byTrigram.get(g);
      if (list === undefined) byTrigram.set(g, [i]);
      else list.push(i);
    }
  };
  items.forEach(add);

  return {
    add,
    same: (name) => byNorm.get(normaliseName(name)) ?? [],
    alike: (name, limit = 3) => {
      const norm = normaliseName(name);
      const grams = trigrams(norm);
      const nums = numbers(norm);
      // Candidates come from the name's rarest pieces: common ones ("ite", " 2k") would pull in
      // half the catalogue. A real look-alike shares most of its pieces, so it shares some rare ones.
      const rare = [...grams]
        .map((g) => ({ g, n: byTrigram.get(g)?.length ?? 0 }))
        .filter((x) => x.n > 0)
        .sort((x, y) => x.n - y.n)
        .slice(0, 8);
      const candidates = new Set<number>();
      for (const { g } of rare) for (const i of byTrigram.get(g)!) candidates.add(i);
      const out: { item: T; score: number }[] = [];
      for (const i of candidates) {
        const c = all[i]!;
        if (c.norm === norm || c.nums !== nums) continue;
        const sc = score(norm, grams, c.norm, c.grams);
        if (sc >= LOOK_ALIKE) out.push({ item: c.item, score: Math.round(sc * 100) / 100 });
      }
      return out.sort((x, y) => y.score - x.score).slice(0, limit);
    },
  };
}
