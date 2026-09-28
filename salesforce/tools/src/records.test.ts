// Tests for the read-only query guard. Run with `npm test` from the repo root.

import assert from "node:assert/strict";
import { test } from "node:test";
import { guardSoql } from "./records.js";
import { assertApiName, assertSalesforceId, soqlString } from "./salesforce.js";

test("a plain SELECT gets a default row cap", () => {
  assert.equal(guardSoql("SELECT Id FROM Account").query, "SELECT Id FROM Account LIMIT 200");
});

test("the query guard refuses anything that isn't a single SELECT", () => {
  assert.throws(() => guardSoql("DELETE FROM Account"));
  assert.throws(() => guardSoql("SELECT Id FROM Account; SELECT Id FROM Lead"));
  assert.throws(() => guardSoql("SELECT Id FROM Account FOR UPDATE"));
});

test("the query guard refuses oversized limits", () => {
  assert.throws(() => guardSoql("SELECT Id FROM Account LIMIT 50000"));
});

test("names with apostrophes are escaped, not injected", () => {
  assert.equal(soqlString("O'Brien Holdings"), "'O\\'Brien Holdings'");
});

test("record IDs and field names are validated before going into a query", () => {
  assert.doesNotThrow(() => assertSalesforceId("001000000000001AAA"));
  assert.throws(() => assertSalesforceId("001' OR Name != '"));
  assert.doesNotThrow(() => assertApiName("custom_field_example__c"));
  assert.throws(() => assertApiName("Name FROM User --"));
});
