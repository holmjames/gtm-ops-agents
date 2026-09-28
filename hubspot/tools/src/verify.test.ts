// Tests against a FAKE HubSpot (no real account needed). They prove the two
// promises this operator is built on:
//   1. A "200 OK" that didn't actually change anything is caught.
//   2. An approved preview can't be applied if the workflow changed since.
// Run with `npm test` from the repo root.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommitGate, runApply, runPreview } from "@gtm-ops/shared";
import { enableWorkflow } from "./commits.js";
import { crmUpdateProperties } from "./crm.js";
import { workflowsSetEnabled } from "./workflows.js";

process.env.HUBSPOT_ACCESS_TOKEN = "fake-token-for-tests";

/** A pretend HubSpot: answers GETs from `state`, and lets tests decide what writes do. */
function fakeHubSpot(state: { workflow: Record<string, unknown>; contact: Record<string, string> }, onWrite: (method: string, body: unknown) => void = () => {}) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (method !== "GET") onWrite(method, init?.body ? JSON.parse(String(init.body)) : undefined);

    if (path.startsWith("/automation/v4/flows/")) return json(state.workflow);
    if (path.startsWith("/crm/v3/objects/contacts/")) return json({ id: "101", properties: state.contact });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const workflow = () => ({ id: "555", name: "ACME Trial Nurture", isEnabled: false, revisionId: "7", actions: [] });

test("a workflow that HubSpot says it enabled, but didn't, is NOT reported as verified", async () => {
  // HubSpot answers 200 to the update, but the workflow stays off.
  fakeHubSpot({ workflow: workflow(), contact: {} });

  const result = await workflowsSetEnabled({ workflowId: "555", isEnabled: true });

  assert.equal(result.ok, false);
  assert.equal(result.audit.verified, false);
});

test("a workflow that really did switch on IS reported as verified", async () => {
  const state = { workflow: workflow(), contact: {} };
  fakeHubSpot(state, (_method, body) => {
    state.workflow = { ...state.workflow, isEnabled: (body as { isEnabled: boolean }).isEnabled };
  });

  const result = await workflowsSetEnabled({ workflowId: "555", isEnabled: true });

  assert.equal(result.ok, true);
  assert.equal(result.audit.verified, true);
});

test("a property update that silently didn't stick is caught, field by field", async () => {
  fakeHubSpot({ workflow: workflow(), contact: { lifecyclestage: "lead" } });

  const result = await crmUpdateProperties({ objectType: "contacts", id: "101", properties: { lifecyclestage: "customer" } });

  assert.equal(result.audit.verified, false);
  assert.deepEqual(result.data?.mismatches, [{ property: "lifecyclestage", wanted: "customer", actual: "lead" }]);
});

test("turning a workflow on is refused if someone edited it after the preview was approved", async () => {
  const state = { workflow: workflow(), contact: {} };
  const writes: string[] = [];
  fakeHubSpot(state, (method) => writes.push(method));
  const gate = new CommitGate();

  const preview = await runPreview(gate, enableWorkflow, { workflowId: "555" });
  assert.equal(preview.ok, true);

  state.workflow = { ...state.workflow, revisionId: "8" }; // a teammate edits the workflow

  const apply = await runApply(gate, enableWorkflow, { workflowId: "555", ticket: String(preview.data?.ticket) });
  assert.equal(apply.error?.code, "changed_since_preview");
  assert.deepEqual(writes, [], "nothing was written to HubSpot");
});

test("a workflow that's already on can't be previewed for turning on", async () => {
  fakeHubSpot({ workflow: { ...workflow(), isEnabled: true }, contact: {} });

  const preview = await runPreview(new CommitGate(), enableWorkflow, { workflowId: "555" });
  assert.equal(preview.error?.code, "nothing_to_apply");
});
