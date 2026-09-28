/**
 * SALESFORCE PLANNING LOGIC (pure: no network calls)
 *
 * The decisions behind round robins, territory assignment, and long report
 * filters, kept separate from the API calls so they can be tested with plain
 * made-up data. See plans.test.ts.
 */

export interface OwnedRecord {
  id: string;
  name: string;
  ownerId: string;
}

export interface Move {
  id: string;
  name: string;
  fromOwnerId: string;
  toOwnerId: string;
}

// ---------------------------------------------------------------------------
// Round robin
// ---------------------------------------------------------------------------

/**
 * Deal records out to owners in turn: 1st record → 1st owner, 2nd → 2nd, …
 * wrapping around. `startIndex` continues a rotation from where the last run
 * left off, so the same rep doesn't always get the first record.
 *
 * Records are sorted by ID first, so the same inputs always produce the
 * same plan. That's what lets the commit gate compare preview and apply.
 */
export function planRoundRobin(records: OwnedRecord[], ownerIds: string[], startIndex = 0) {
  if (ownerIds.length === 0) throw new Error("Round robin needs at least one owner.");
  if (new Set(ownerIds).size !== ownerIds.length) throw new Error("Each owner can appear only once in the rotation.");

  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const moves: Move[] = [];
  const unchanged: OwnedRecord[] = [];
  const perOwner: Record<string, { assigned: number; gained: number; lost: number }> = {};

  for (const owner of ownerIds) perOwner[owner] = { assigned: 0, gained: 0, lost: 0 };

  sorted.forEach((record, i) => {
    const toOwnerId = ownerIds[(startIndex + i) % ownerIds.length];
    perOwner[toOwnerId].assigned += 1;

    if (record.ownerId === toOwnerId) {
      unchanged.push(record);
      return;
    }

    moves.push({ id: record.id, name: record.name, fromOwnerId: record.ownerId, toOwnerId });
    perOwner[toOwnerId].gained += 1;
    if (perOwner[record.ownerId]) perOwner[record.ownerId].lost += 1;
  });

  return {
    moves,
    unchanged,
    perOwner,
    nextStartIndex: (startIndex + sorted.length) % ownerIds.length,
  };
}

// ---------------------------------------------------------------------------
// Territories
// ---------------------------------------------------------------------------

export interface TerritoryRule {
  territory: string;
  ownerId: string;
  field: string;
  operator: "equals" | "in" | "startsWith";
  values: string[];
}

export interface TerritoryRecord extends OwnedRecord {
  fields: Record<string, string | null>;
  currentTerritory?: string | null;
}

function clean(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function ruleMatches(rule: TerritoryRule, record: TerritoryRecord) {
  const actual = clean(record.fields[rule.field]);
  if (!actual) return false;

  const wanted = rule.values.map(clean);
  switch (rule.operator) {
    case "equals":
    case "in":
      return wanted.includes(actual);
    case "startsWith":
      return wanted.some((w) => actual.startsWith(w));
  }
}

/**
 * Assign each record to the FIRST rule it matches (rule order is priority
 * order: put specific rules above broad ones). Records that match no rule
 * are listed, never silently left behind.
 */
export function planTerritories(records: TerritoryRecord[], rules: TerritoryRule[], opts: { setsTerritoryField: boolean }) {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const moves: (Move & { territory: string; fromTerritory: string | null })[] = [];
  const unchanged: (OwnedRecord & { territory: string })[] = [];
  const unmatched: OwnedRecord[] = [];
  const byTerritory: Record<string, { ownerId: string; records: number; moving: number }> = {};

  for (const rule of rules) byTerritory[rule.territory] ??= { ownerId: rule.ownerId, records: 0, moving: 0 };

  for (const record of sorted) {
    const rule = rules.find((r) => ruleMatches(r, record));

    if (!rule) {
      unmatched.push({ id: record.id, name: record.name, ownerId: record.ownerId });
      continue;
    }

    byTerritory[rule.territory].records += 1;
    const ownerSame = record.ownerId === rule.ownerId;
    const territorySame = !opts.setsTerritoryField || clean(record.currentTerritory) === clean(rule.territory);

    if (ownerSame && territorySame) {
      unchanged.push({ id: record.id, name: record.name, ownerId: record.ownerId, territory: rule.territory });
      continue;
    }

    byTerritory[rule.territory].moving += 1;
    moves.push({
      id: record.id,
      name: record.name,
      fromOwnerId: record.ownerId,
      toOwnerId: rule.ownerId,
      territory: rule.territory,
      fromTerritory: record.currentTerritory ?? null,
    });
  }

  return { moves, unchanged, unmatched, byTerritory };
}

// ---------------------------------------------------------------------------
// Report filters
// ---------------------------------------------------------------------------

/**
 * Salesforce report filters top out around 2,200 characters. A filter on a
 * few hundred record IDs blows past that, and the API fails loudly.
 *
 * So: split the values into groups whose comma-joined text stays under
 * `maxChars` (default 2,000, leaving headroom). Each group becomes its own
 * report ("… (1 of 3)", "… (2 of 3)", …).
 */
export function chunkFilterValues(values: string[], maxChars = 2000) {
  const groups: string[][] = [];
  let current: string[] = [];
  let length = 0;

  for (const value of values) {
    if (value.length > maxChars) throw new Error(`A single filter value is longer than ${maxChars} characters.`);

    const added = current.length === 0 ? value.length : value.length + 1; // +1 for the comma
    if (length + added > maxChars) {
      groups.push(current);
      current = [];
      length = 0;
    }

    current.push(value);
    length += current.length === 1 ? value.length : value.length + 1;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}
