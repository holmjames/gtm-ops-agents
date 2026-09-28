// Tests for Outreach enrollment and state-change planning, with made-up ACME prospects.
// Run with `npm test` from the repo root.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuery, filterParam } from "./outreach.js";
import { planEnrollment, planStateChange, type ProspectFacts } from "./plans.js";

const SEQUENCE = 900;

const prospect = (id: number, overrides: Partial<ProspectFacts> = {}): ProspectFacts => ({
  id,
  name: `ACME Prospect ${id}`,
  optedOut: false,
  activeSequenceIds: [],
  allSequenceIds: [],
  ...overrides,
});

test("opted-out prospects are never enrolled", () => {
  const plan = planEnrollment([1, 2], [prospect(1), prospect(2, { optedOut: true })], SEQUENCE, { allowActiveElsewhere: true });

  assert.deepEqual(plan.eligible.map((p) => p.id), [1]);
  assert.equal(plan.excludedByReason.opted_out, 1);
});

test("opt-out wins even when other settings would allow enrollment", () => {
  const plan = planEnrollment([1], [prospect(1, { optedOut: true })], SEQUENCE, { allowActiveElsewhere: true });
  assert.equal(plan.eligible.length, 0);
});

test("prospects already in this sequence are not added twice", () => {
  const plan = planEnrollment([1], [prospect(1, { allSequenceIds: [SEQUENCE] })], SEQUENCE, { allowActiveElsewhere: true });
  assert.equal(plan.excludedByReason.already_in_this_sequence, 1);
});

test("prospects active in another sequence are held back by default", () => {
  const busy = prospect(1, { activeSequenceIds: [123], allSequenceIds: [123] });

  assert.equal(planEnrollment([1], [busy], SEQUENCE, { allowActiveElsewhere: false }).eligible.length, 0);
  assert.equal(planEnrollment([1], [busy], SEQUENCE, { allowActiveElsewhere: true }).eligible.length, 1);
});

test("unknown IDs are reported, and duplicates are counted once", () => {
  const plan = planEnrollment([1, 1, 404], [prospect(1)], SEQUENCE, { allowActiveElsewhere: false });

  assert.deepEqual(plan.eligible.map((p) => p.id), [1]);
  assert.deepEqual(plan.excluded, [{ id: 404, reason: "not_found" }]);
});

test("pause only touches running prospects", () => {
  const plan = planStateChange(
    [
      { id: 2, state: "paused" },
      { id: 1, state: "active" },
      { id: 3, state: "finished" },
    ],
    "pause",
  );

  assert.deepEqual(plan.change.map((s) => s.id), [1]);
  assert.deepEqual(plan.skip.map((s) => s.id), [2, 3]);
  assert.equal(plan.expectedState, "paused");
});

test("filters are built safely", () => {
  assert.equal(filterParam("sequence.id"), "filter[sequence][id]");
  assert.throws(() => filterParam("id]&delete[x"));
  assert.equal(decodeURIComponent(buildQuery({ id: [1, 2, 3] }, 50)), "filter[id]=1,2,3&page[size]=50");
});
