/**
 * OUTREACH READ AND BUILD TOOLS
 *
 * Read:   a guarded query, prospect lookup by email
 * Build:  create a sequence switched off (with its email steps)
 * Safe:   turn a sequence off (always allowed; it's the safe direction)
 */

import { makeEnvelope, makeErrorEnvelope, type ToolEnvelope } from "@gtm-ops/shared";
import { count, flatten, list, listAll, listByIds, outreachRequest, rel, relatedId, type JsonApiRecord } from "./outreach.js";

/** "In a sequence" means any of these states. */
export const LIVE_STATES = ["active", "pending", "paused"];

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const QUERYABLE = ["prospects", "accounts", "sequences", "sequenceStates", "sequenceSteps", "mailboxes", "users", "templates"] as const;

/** Look things up, read-only, from an allow-list of record types. */
export async function query(input: {
  resource: (typeof QUERYABLE)[number];
  filters?: Record<string, string | number | boolean>;
  limit?: number;
}): Promise<ToolEnvelope> {
  const operation = "query";
  const audit = { attempted: false, verified: false, targetType: input.resource };

  try {
    const records = await listAll(input.resource, input.filters ?? {}, Math.min(input.limit ?? 100, 1000));
    return makeEnvelope(operation, audit, { count: records.length, records: records.map(flatten) });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit });
  }
}

/** Everything a human would want to know about a prospect before touching them. */
export async function prospectFacts(prospects: JsonApiRecord[]) {
  const ids = prospects.map((p) => p.id);
  const states = ids.length ? await listByIds("sequenceStates", ids, "prospect.id") : [];

  return prospects.map((p) => {
    const mine = states.filter((s) => relatedId(s, "prospect") === p.id);
    const a = p.attributes ?? {};
    return {
      id: p.id,
      name: [a.firstName, a.lastName].filter(Boolean).join(" ") || `Prospect ${p.id}`,
      emails: a.emails ?? [],
      ownerId: relatedId(p, "owner"),
      optedOut: a.optedOut === true,
      activeSequenceIds: mine.filter((s) => LIVE_STATES.includes(String(s.attributes?.state))).map((s) => Number(relatedId(s, "sequence"))),
      allSequenceIds: mine.map((s) => Number(relatedId(s, "sequence"))),
    };
  });
}

export async function prospectsFindByEmail(input: { emails: string[] }): Promise<ToolEnvelope> {
  const operation = "prospects.find_by_email";
  const audit = { attempted: false, verified: false, targetType: "prospect" };

  try {
    const results = [];
    for (const email of input.emails) {
      const found = (await list("prospects", { emails: email }, 5)).data;
      const facts = await prospectFacts(found);
      results.push({ email, matches: facts.length, prospects: facts });
    }
    return makeEnvelope(operation, audit, { results });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit });
  }
}

// ---------------------------------------------------------------------------
// Build: sequences, created OFF
// ---------------------------------------------------------------------------

interface StepInput {
  type: "auto_email" | "manual_email" | "call" | "task";
  waitDays: number;
  subject?: string;
  bodyHtml?: string;
  note?: string;
}

/**
 * Create a sequence that is OFF, with nobody in it, and build its steps.
 * Email steps get their template (subject + body) attached, so a reviewer
 * can read the actual copy before anything is switched on.
 */
export async function sequencesCreate(input: { name: string; description?: string; steps: StepInput[] }): Promise<ToolEnvelope> {
  const operation = "sequences.create";
  const audit = { attempted: false, verified: false, targetType: "sequence", targetName: input.name };

  try {
    const existing = (await list("sequences", { name: input.name }, 5)).data;
    if (existing.length > 0) {
      return makeErrorEnvelope({
        operation,
        code: "name_taken",
        error: new Error(`A sequence named "${input.name}" already exists.`),
        audit,
        data: { existing: existing.map(flatten) },
      });
    }

    const created = await outreachRequest<{ data: JsonApiRecord }>("/sequences", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "sequence",
          attributes: { name: input.name, description: input.description ?? "", sequenceType: "interval", shareType: "private" },
        },
      }),
    });
    const sequenceId = created.data.id;

    for (const [i, step] of input.steps.entries()) {
      const stepRecord = await outreachRequest<{ data: JsonApiRecord }>("/sequenceSteps", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "sequenceStep",
            // Outreach measures the wait before a step in minutes.
            attributes: { stepType: step.type, order: i + 1, interval: Math.round(step.waitDays * 24 * 60), taskNote: step.note },
            relationships: { sequence: rel("sequence", sequenceId) },
          },
        }),
      });

      if (step.type.endsWith("_email")) {
        const template = await outreachRequest<{ data: JsonApiRecord }>("/templates", {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "template",
              attributes: { name: `${input.name} - step ${i + 1}`, subject: step.subject ?? "", bodyHtml: step.bodyHtml ?? "" },
            },
          }),
        });
        await outreachRequest("/sequenceTemplates", {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "sequenceTemplate",
              relationships: { sequenceStep: rel("sequenceStep", stepRecord.data.id), template: rel("template", template.data.id) },
            },
          }),
        });
      }
    }

    // Verify: it exists, it's OFF, nobody is in it, and every step is there.
    const readback = await outreachRequest<{ data: JsonApiRecord }>(`/sequences/${sequenceId}`);
    const stepCount = await count("sequenceSteps", { "sequence.id": sequenceId });
    const prospectCount = await count("sequenceStates", { "sequence.id": sequenceId });
    const isOff = readback.data.attributes?.enabled !== true;
    const verified = isOff && stepCount === input.steps.length && prospectCount === 0;
    const doneAudit = { ...audit, attempted: true, verified, targetId: String(sequenceId) };
    const data = { sequence: flatten(readback.data), steps: stepCount, prospects: prospectCount };

    return verified
      ? makeEnvelope(operation, doneAudit, data)
      : makeErrorEnvelope({
          operation,
          error: new Error(
            isOff
              ? "The sequence was created, but its steps or prospects didn't read back as expected."
              : "The sequence was created ENABLED. Turn it off with sequences.deactivate and review it.",
          ),
          audit: doneAudit,
          data,
        });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: { ...audit, attempted: true } });
  }
}

// ---------------------------------------------------------------------------
// Safe direction: turn a sequence OFF
// ---------------------------------------------------------------------------

export async function setSequenceEnabled(sequenceId: number, enabled: boolean, operation: string): Promise<ToolEnvelope> {
  const audit = { attempted: true, verified: false, targetType: "sequence", targetId: String(sequenceId) };

  try {
    await outreachRequest(`/sequences/${sequenceId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { type: "sequence", id: sequenceId, attributes: { enabled } } }),
    });
    const readback = await outreachRequest<{ data: JsonApiRecord }>(`/sequences/${sequenceId}`);
    const verified = readback.data.attributes?.enabled === enabled;

    return verified
      ? makeEnvelope(operation, { ...audit, verified, targetName: String(readback.data.attributes?.name ?? "") }, { sequence: flatten(readback.data) })
      : makeErrorEnvelope({
          operation,
          error: new Error(`Outreach accepted the change, but the sequence still reads enabled=${String(readback.data.attributes?.enabled)}.`),
          audit,
        });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit });
  }
}
