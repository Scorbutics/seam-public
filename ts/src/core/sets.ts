// Small Set helpers — Python `set` operations have no direct JS equivalent, so the
// deterministic passes (ported verbatim from Python) lean on these. Kept tiny and pure.

export function union<T>(...sets: Iterable<T>[]): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const x of s) out.add(x);
  return out;
}

export function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) out.add(x);
  return out;
}

export function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

export function sorted<T>(it: Iterable<T>): T[] {
  // Python sorted() on strings = lexicographic by code point; default JS sort on
  // strings matches for ASCII. Numbers need a comparator.
  const arr = [...it];
  if (arr.length && typeof arr[0] === "number") {
    return (arr as unknown as number[]).sort((x, y) => x - y) as unknown as T[];
  }
  return (arr as unknown as string[]).sort() as unknown as T[];
}

/** Python `re.findall` with exactly ONE capture group → list of that group. */
export function findGroup1(re: RegExp, s: string): string[] {
  const g = re.global ? re : new RegExp(re.source, re.flags + "g");
  const out: string[] = [];
  for (const m of s.matchAll(g)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

/** Python `re.findall` with NO capture group → list of full matches. */
export function findAll(re: RegExp, s: string): string[] {
  const g = re.global ? re : new RegExp(re.source, re.flags + "g");
  const out: string[] = [];
  for (const m of s.matchAll(g)) out.push(m[0]);
  return out;
}
