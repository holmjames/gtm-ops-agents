// Tests for the commit gate. Run with `npm test` from the repo root.
// Each test states one promise the gate makes, in plain English.

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { CommitGate, canonicalJson } from "./commitGate.js";
import { defineCommitAction, runApply, runPreview } from "./commitTools.js";
import { makeEnvelope } from "./envelope.js";

test("a ticket applies once when nothing has changed", () => {
  const gate = new CommitGate();
  const { ticket } = gate.issue("owners.round_robin", { ids: ["a", "b"] });

  assert.deepEqual(gate.redeem(ticket, "owners.round_robin", { ids: ["a", "b"] }), { ok: true });
});

test("a ticket cannot be used twice", () => {
  const gate = new CommitGate();
  const { ticket } = gate.issue("x", { n: 1 });
  gate.redeem(ticket, "x", { n: 1 });

  const second = gate.redeem(ticket, "x", { n: 1 });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.code, "already_used");
});

test("a ticket is refused if the live data changed after the preview", () => {
  const gate = new CommitGate();
  const { ticket } = gate.issue("x", { recipients: 1240 });

  const result = gate.redeem(ticket, "x", { recipients: 1241 });
  assert.equal(!result.ok && result.code, "changed_since_preview");
});

test("a refused apply does not burn the ticket", () => {
  const gate = new CommitGate();
  const { ticket } = gate.issue("x", { v: 1 });
  gate.redeem(ticket, "x", { v: 2 });

  assert.deepEqual(gate.redeem(ticket, "x", { v: 1 }), { ok: true });
});

test("a ticket for one action cannot unlock a different action", () => {
  const gate = new CommitGate();
  const { ticket } = gate.issue("workflows.enable", { id: "1" });

  const result = gate.redeem(ticket, "workflows.delete", { id: "1" });
  assert.equal(!result.ok && result.code, "wrong_action");
});

test("a ticket expires", () => {
  let now = 0;
  const gate = new CommitGate({ ttlMs: 1000, now: () => now });
  const { ticket } = gate.issue("x", {});
  now = 1001;

  const result = gate.redeem(ticket, "x", {});
  assert.equal(!result.ok && result.code, "expired");
});

test("an invented ticket is refused", () => {
  const result = new CommitGate().redeem("ct_madeup", "x", {});
  assert.equal(!result.ok && result.code, "unknown_ticket");
});

test("fingerprints ignore key order", () => {
  assert.equal(canonicalJson({ a: 1, b: [2, { d: 3, c: 4 }] }), canonicalJson({ b: [2, { c: 4, d: 3 }], a: 1 }));
});

// --- The preview → apply wrapper -------------------------------------------

function fakeAction(liveData: { audience: number }, applied: string[]) {
  return defineCommitAction({
    name: "demo.send",
    description: "Send a demo email.",
    inputSchema: z.object({ campaign: z.string() }),
    async plan(input) {
      return {
        targetType: "campaign",
        targetName: input.campaign,
        summary: `Send to ${liveData.audience} people.`,
        preview: { audience: liveData.audience },
        fingerprint: { campaign: input.campaign, audience: liveData.audience },
        blocked: liveData.audience === 0 ? "Nobody to send to." : undefined,
        state: null,
      };
    },
    async apply(input) {
      applied.push(input.campaign);
      return makeEnvelope("demo.send.apply", { attempted: true, verified: true, targetType: "campaign" });
    },
  });
}

test("preview changes nothing and returns a ticket", async () => {
  const applied: string[] = [];
  const result = await runPreview(new CommitGate(), fakeAction({ audience: 5 }, applied), { campaign: "ACME" });

  assert.equal(result.ok, true);
  assert.match(String(result.data?.ticket), /^ct_/);
  assert.deepEqual(applied, []);
});

test("apply runs with a valid ticket", async () => {
  const gate = new CommitGate();
  const applied: string[] = [];
  const action = fakeAction({ audience: 5 }, applied);
  const preview = await runPreview(gate, action, { campaign: "ACME" });

  const result = await runApply(gate, action, { campaign: "ACME", ticket: String(preview.data?.ticket) });
  assert.equal(result.ok, true);
  assert.deepEqual(applied, ["ACME"]);
});

test("apply is refused if the audience grew after approval", async () => {
  const gate = new CommitGate();
  const applied: string[] = [];
  const live = { audience: 5 };
  const action = fakeAction(live, applied);
  const preview = await runPreview(gate, action, { campaign: "ACME" });

  live.audience = 500; // someone changed the list after the human approved 5
  const result = await runApply(gate, action, { campaign: "ACME", ticket: String(preview.data?.ticket) });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "changed_since_preview");
  assert.deepEqual(applied, []);
});

test("apply is refused if the inputs differ from the preview", async () => {
  const gate = new CommitGate();
  const applied: string[] = [];
  const action = fakeAction({ audience: 5 }, applied);
  const preview = await runPreview(gate, action, { campaign: "ACME" });

  const result = await runApply(gate, action, { campaign: "OTHER", ticket: String(preview.data?.ticket) });
  assert.equal(result.ok, false);
  assert.deepEqual(applied, []);
});

test("a blocked plan never issues a ticket", async () => {
  const result = await runPreview(new CommitGate(), fakeAction({ audience: 0 }, []), { campaign: "ACME" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "nothing_to_apply");
  assert.equal(result.data?.ticket, undefined);
});
