/**
 * OUTREACH COMMIT ACTIONS
 *
 * The Outreach actions that change what's live: turning a sequence on,
 * enrolling prospects (this is when email starts going out), pausing /
 * resuming / finishing prospects in a sequence, and deleting. Each is split
 * into plan (look, change nothing) and apply (change, then verify). The shared
 * commit gate turns each into `.preview` and `.apply` tools.
 */

import { defineCommitAction, makeEnvelope, makeErrorEnvelope } from "@gtm-ops/shared";
import { z } from "zod";
import { count, flatten, listByIds, outreachRequest, rel, relatedId, type JsonApiRecord } from "./outreach.js";
import { planEnrollment, planStateChange } from "./plans.js";
import { LIVE_STATES, prospectFacts, setSequenceEnabled } from "./tools.js";

const outreachId = z.number().int().positive();

async function getSequence(sequenceId: number) {
  return (await outreachRequest<{ data: JsonApiRecord }>(`/sequences/${sequenceId}`)).data;
}

// ---------------------------------------------------------------------------
// Turn a sequence ON
// ---------------------------------------------------------------------------

export const activateSequence = defineCommitAction({
  name: "sequences.activate",
  description: "Turn a sequence ON. Anyone already enrolled starts receiving its steps on schedule.",
  inputSchema: z.object({ sequenceId: outreachId }),
  async plan(input) {
    const sequence = await getSequence(input.sequenceId);
    const a = sequence.attributes ?? {};
    const steps = await listByIds("sequenceSteps", [input.sequenceId], "sequence.id");
    const waiting = await count("sequenceStates", { "sequence.id": input.sequenceId, state: LIVE_STATES });

    return {
      targetType: "sequence",
      targetId: String(input.sequenceId),
      targetName: String(a.name ?? ""),
      summary: `Turn ON "${String(a.name)}". ${waiting} prospect(s) already in it will start receiving steps.`,
      preview: {
        sequence: { id: input.sequenceId, name: a.name, currentlyEnabled: a.enabled },
        prospectsWhoWillStartReceiving: waiting,
        steps: steps
          .map((s) => ({ order: s.attributes?.order, type: s.attributes?.stepType, waitMinutes: s.attributes?.interval }))
          .sort((x, y) => Number(x.order) - Number(y.order)),
      },
      fingerprint: { id: input.sequenceId, updatedAt: a.updatedAt ?? null, stepIds: steps.map((s) => s.id).sort(), waiting },
      blocked: a.enabled === true ? "This sequence is already on." : steps.length === 0 ? "This sequence has no steps." : undefined,
      state: null,
    };
  },
  apply: (input) => setSequenceEnabled(input.sequenceId, true, "sequences.activate.apply"),
});

// ---------------------------------------------------------------------------
// Enroll prospects
// ---------------------------------------------------------------------------

export const enrollProspects = defineCommitAction({
  name: "sequences.enroll",
  description:
    "Add prospects to a sequence, sending from a given mailbox. Opted-out prospects are always excluded; " +
    "prospects active in another sequence are excluded unless allowActiveElsewhere is true.",
  inputSchema: z.object({
    sequenceId: outreachId,
    mailboxId: outreachId.describe("The mailbox the emails will be sent from."),
    prospectIds: z.array(outreachId).min(1).max(500),
    allowActiveElsewhere: z.boolean().optional(),
  }),
  async plan(input) {
    const sequence = await getSequence(input.sequenceId);
    const mailbox = (await outreachRequest<{ data: JsonApiRecord }>(`/mailboxes/${input.mailboxId}`)).data;
    const prospects = await prospectFacts(await listByIds("prospects", input.prospectIds));
    const plan = planEnrollment(input.prospectIds, prospects, input.sequenceId, {
      allowActiveElsewhere: input.allowActiveElsewhere ?? false,
    });

    const on = sequence.attributes?.enabled === true;
    const sendingFrom = String(mailbox.attributes?.email ?? input.mailboxId);

    return {
      targetType: "sequence",
      targetId: String(input.sequenceId),
      targetName: String(sequence.attributes?.name ?? ""),
      summary: `Enroll ${plan.eligible.length} prospect(s) in "${String(sequence.attributes?.name)}", sending from ${sendingFrom}.`,
      preview: {
        willEnroll: plan.eligible.length,
        sample: plan.eligible.slice(0, 25).map((p) => p.name),
        excluded: plan.excludedByReason,
        excludedDetail: plan.excluded.slice(0, 100),
        sendingFrom,
        whenEmailStarts: on
          ? "The sequence is ON: the first step starts going out on its schedule as soon as they're added."
          : "The sequence is OFF: prospects will wait, and nothing sends until the sequence is activated.",
      },
      fingerprint: {
        sequenceId: input.sequenceId,
        mailboxId: input.mailboxId,
        sequenceEnabled: on,
        eligible: plan.eligible.map((p) => p.id),
      },
      blocked: plan.eligible.length === 0 ? "Nobody is eligible to enroll." : undefined,
      state: { eligibleIds: plan.eligible.map((p) => p.id) },
    };
  },
  async apply(input, plan) {
    const operation = "sequences.enroll.apply";
    const audit = { attempted: true, verified: false, targetType: "sequence", targetId: String(input.sequenceId) };
    const failures: { prospectId: number; error: string }[] = [];

    // Outreach enrolls one prospect per request.
    for (const prospectId of plan.state.eligibleIds) {
      try {
        await outreachRequest("/sequenceStates", {
          method: "POST",
          body: JSON.stringify({
            data: {
              type: "sequenceState",
              relationships: {
                prospect: rel("prospect", prospectId),
                sequence: rel("sequence", input.sequenceId),
                mailbox: rel("mailbox", input.mailboxId),
              },
            },
          }),
        });
      } catch (error) {
        failures.push({ prospectId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Verify: read back who is actually in the sequence now.
    const states = await listByIds("sequenceStates", plan.state.eligibleIds, "prospect.id");
    const enrolled = new Set(
      states.filter((s) => relatedId(s, "sequence") === input.sequenceId).map((s) => Number(relatedId(s, "prospect"))),
    );
    const notEnrolled = plan.state.eligibleIds.filter((id) => !enrolled.has(id));
    const data = { enrolled: enrolled.size, notEnrolled, failures };

    return notEnrolled.length === 0
      ? makeEnvelope(operation, { ...audit, verified: true }, data)
      : makeErrorEnvelope({ operation, error: new Error(`${notEnrolled.length} prospect(s) did not end up in the sequence.`), audit, data });
  },
});

// ---------------------------------------------------------------------------
// Pause / resume / finish prospects in a sequence
// ---------------------------------------------------------------------------

/**
 * Outreach doesn't let you edit a sequence state directly. Each change is its
 * own dedicated action (POST /sequenceStates/{id}/actions/pause, …).
 */
export const changeSequenceStates = defineCommitAction({
  name: "sequence_states.change",
  description: "Pause, resume, or finish prospects' progress through a sequence.",
  inputSchema: z.object({
    action: z.enum(["pause", "resume", "finish"]),
    sequenceStateIds: z.array(outreachId).min(1).max(200),
  }),
  async plan(input) {
    const records = await listByIds("sequenceStates", input.sequenceStateIds);
    const states = records.map((s) => ({ id: s.id, state: String(s.attributes?.state) }));
    const plan = planStateChange(states, input.action);

    return {
      targetType: "sequence_state",
      summary: `${input.action} ${plan.change.length} prospect(s) in their sequence.`,
      preview: {
        willChange: plan.change.length,
        becomes: plan.expectedState,
        skipped: plan.skip.map((s) => ({ id: s.id, currentState: s.state })),
        notFound: input.sequenceStateIds.filter((id) => !states.some((s) => s.id === id)),
      },
      fingerprint: { action: input.action, change: plan.change },
      blocked: plan.change.length === 0 ? `None of these can be ${input.action}d from their current state.` : undefined,
      state: { ids: plan.change.map((s) => s.id), expectedState: plan.expectedState },
    };
  },
  async apply(input, plan) {
    const operation = "sequence_states.change.apply";
    const audit = { attempted: true, verified: false, targetType: "sequence_state" };

    for (const id of plan.state.ids) {
      await outreachRequest(`/sequenceStates/${id}/actions/${input.action}`, { method: "POST" });
    }

    const after = await listByIds("sequenceStates", plan.state.ids);
    const wrong = after.filter((s) => s.attributes?.state !== plan.state.expectedState).map(flatten);

    return wrong.length === 0
      ? makeEnvelope(operation, { ...audit, verified: true }, { changed: plan.state.ids.length })
      : makeErrorEnvelope({ operation, error: new Error("Some sequence states didn't change as expected."), audit, data: { wrong } });
  },
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const RESOURCE_TYPE = { prospects: "prospect", sequences: "sequence" } as const;

export const deleteOutreachRecords = defineCommitAction({
  name: "records.delete",
  description: "Delete prospects or sequences. Outreach has no recycle bin: this is permanent.",
  inputSchema: z.object({
    resource: z.enum(["prospects", "sequences"]),
    ids: z.array(outreachId).min(1).max(100),
  }),
  async plan(input) {
    const records = await listByIds(input.resource, input.ids);
    const described = await Promise.all(
      records.map(async (r) => ({
        id: r.id,
        name:
          input.resource === "sequences"
            ? String(r.attributes?.name)
            : [r.attributes?.firstName, r.attributes?.lastName].filter(Boolean).join(" "),
        prospectsInSequence:
          input.resource === "sequences" ? await count("sequenceStates", { "sequence.id": r.id, state: LIVE_STATES }) : undefined,
      })),
    );

    return {
      targetType: RESOURCE_TYPE[input.resource],
      summary: `Permanently delete ${records.length} ${input.resource}.`,
      preview: {
        willDelete: described,
        notFound: input.ids.filter((id) => !records.some((r) => r.id === id)),
        warning: "Outreach has no recycle bin. This cannot be undone.",
      },
      fingerprint: { resource: input.resource, ids: records.map((r) => r.id).sort((a, b) => a - b) },
      blocked: records.length === 0 ? "None of these records exist." : undefined,
      state: { ids: records.map((r) => r.id) },
    };
  },
  async apply(input, plan) {
    const operation = "records.delete.apply";
    const audit = { attempted: true, verified: false, targetType: RESOURCE_TYPE[input.resource] };

    for (const id of plan.state.ids) {
      await outreachRequest(`/${input.resource}/${id}`, { method: "DELETE" });
    }

    const stillThere = await listByIds(input.resource, plan.state.ids);
    return stillThere.length === 0
      ? makeEnvelope(operation, { ...audit, verified: true }, { deleted: plan.state.ids.length })
      : makeErrorEnvelope({ operation, error: new Error("Some records still exist after delete."), audit, data: { stillThere: stillThere.map(flatten) } });
  },
});
