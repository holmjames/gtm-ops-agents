// Tests for the Salesforce planning logic, using made-up ACME data.
// Run with `npm test` from the repo root.

import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkFilterValues, planRoundRobin, planTerritories, type TerritoryRule } from "./plans.js";

const accounts = (n: number, ownerId = "005REP_OLD") =>
  Array.from({ length: n }, (_, i) => ({
    id: `001ACME${String(i).padStart(4, "0")}`,
    name: `ACME Account ${i}`,
    ownerId,
  }));

// --- Round robin ------------------------------------------------------------

test("round robin splits 40 accounts evenly across 4 reps", () => {
  const plan = planRoundRobin(accounts(40), ["005A", "005B", "005C", "005D"]);

  assert.equal(plan.moves.length, 40);
  for (const rep of ["005A", "005B", "005C", "005D"]) assert.equal(plan.perOwner[rep].assigned, 10);
});

test("round robin continues the rotation from where it left off", () => {
  const first = planRoundRobin(accounts(3), ["005A", "005B"]);
  assert.equal(first.nextStartIndex, 1);

  const second = planRoundRobin(accounts(1), ["005A", "005B"], first.nextStartIndex);
  assert.equal(second.moves[0].toOwnerId, "005B");
});

test("round robin leaves a record alone if it already belongs to its assigned rep", () => {
  const plan = planRoundRobin(accounts(1, "005A"), ["005A", "005B"]);

  assert.equal(plan.moves.length, 0);
  assert.equal(plan.unchanged.length, 1);
});

test("round robin gives the same plan no matter the input order", () => {
  const records = accounts(7);
  const a = planRoundRobin(records, ["005A", "005B", "005C"]);
  const b = planRoundRobin([...records].reverse(), ["005A", "005B", "005C"]);

  assert.deepEqual(a, b);
});

test("round robin refuses a rotation that lists the same rep twice", () => {
  assert.throws(() => planRoundRobin(accounts(2), ["005A", "005A"]));
});

// --- Territories ------------------------------------------------------------

const rules: TerritoryRule[] = [
  { territory: "West", ownerId: "005WEST", field: "BillingState", operator: "in", values: ["CA", "OR", "WA"] },
  { territory: "Northeast", ownerId: "005NE", field: "BillingState", operator: "in", values: ["NY", "MA"] },
];

const withState = (id: string, state: string | null, ownerId = "005OLD") => ({
  id,
  name: `ACME ${id}`,
  ownerId,
  fields: { BillingState: state },
});

test("territory rules assign each account to the matching territory's owner", () => {
  const plan = planTerritories(
    [withState("001A", "CA"), withState("001B", "ny"), withState("001C", " wa ")],
    rules,
    { setsTerritoryField: false },
  );

  assert.deepEqual(
    plan.moves.map((m) => [m.id, m.territory, m.toOwnerId]),
    [
      ["001A", "West", "005WEST"],
      ["001B", "Northeast", "005NE"],
      ["001C", "West", "005WEST"],
    ],
  );
});

test("accounts that match no territory are listed, not dropped", () => {
  const plan = planTerritories([withState("001A", "TX"), withState("001B", null)], rules, { setsTerritoryField: false });

  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.unmatched.map((r) => r.id), ["001A", "001B"]);
});

test("the first matching rule wins, so specific rules can sit above broad ones", () => {
  const layered: TerritoryRule[] = [
    { territory: "Bay Area", ownerId: "005BAY", field: "BillingPostalCode", operator: "startsWith", values: ["941"] },
    { territory: "West", ownerId: "005WEST", field: "BillingState", operator: "equals", values: ["CA"] },
  ];
  const record = { id: "001A", name: "ACME SF", ownerId: "005OLD", fields: { BillingPostalCode: "94107", BillingState: "CA" } };

  assert.equal(planTerritories([record], layered, { setsTerritoryField: false }).moves[0].territory, "Bay Area");
});

test("an account already with the right owner and territory is unchanged", () => {
  const record = { ...withState("001A", "CA", "005WEST"), currentTerritory: "West" };
  const plan = planTerritories([record], rules, { setsTerritoryField: true });

  assert.equal(plan.moves.length, 0);
  assert.equal(plan.unchanged.length, 1);
});

// --- Report filter chunking ---------------------------------------------------

test("a long ID filter is split into chunks that each fit the limit", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `001ACME0000${String(i).padStart(4, "0")}`); // 15 chars each
  const groups = chunkFilterValues(ids, 2000);

  assert.ok(groups.length > 1);
  for (const g of groups) assert.ok(g.join(",").length <= 2000);
  assert.deepEqual(groups.flat(), ids);
});

test("a short filter stays in one piece", () => {
  assert.deepEqual(chunkFilterValues(["a", "b", "c"]), [["a", "b", "c"]]);
});
