/**
 * Small text helpers used for exact-match targeting.
 *
 * Write tools never act on a fuzzy match. "Onboarding" must not select
 * "Onboarding - OLD DO NOT USE". A name has to match exactly (ignoring case
 * and surrounding spaces), and it has to match exactly ONE thing.
 */

export function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

export type ExactMatch<T> =
  | { status: "found"; match: T }
  | { status: "none" }
  | { status: "ambiguous"; candidates: T[] };

export function exactNameMatch<T>(items: T[], name: string, getName: (item: T) => string | undefined): ExactMatch<T> {
  const target = normalizeText(name);
  const hits = items.filter((item) => {
    const itemName = getName(item);
    return itemName !== undefined && normalizeText(itemName) === target;
  });

  if (hits.length === 1) return { status: "found", match: hits[0] };
  if (hits.length === 0) return { status: "none" };
  return { status: "ambiguous", candidates: hits };
}

/** Split a list into groups of at most `size` (APIs cap batch sizes). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
