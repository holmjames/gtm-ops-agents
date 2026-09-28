/**
 * SALESFORCE COMMIT ACTIONS
 *
 * The Salesforce actions that change live data: reassigning owners (round
 * robin), assigning territories, adding campaign members, and deleting
 * records. Each is split into plan (look, change nothing) and apply (change,
 * then verify). The shared commit gate turns each into `.preview` and
 * `.apply` tools. See shared/tools/src/commitTools.ts.
 *
 * Every preview answers "what will change, for whom, and what gets skipped?"
 * with names and counts, not just IDs.
 */

import { defineCommitAction, makeEnvelope, makeErrorEnvelope, chunk } from "@gtm-ops/shared";
import { z } from "zod";
import { planRoundRobin, planTerritories, type Move } from "./plans.js";
import {
  assertApiName,
  createRecords,
  deleteRecords,
  failedSaves,
  queryByIds,
  soql,
  soqlString,
  updateRecords,
  assertSalesforceId,
} from "./salesforce.js";

const idList = (max: number) => z.array(z.string()).min(1).max(max);
const ownableObject = z.enum(["Lead", "Account", "Opportunity", "Contact"]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Look up users so previews say "Jordan Lee" instead of "005…". */
async function loadUsers(ids: string[]) {
  const unique = [...new Set(ids)];
  const users = unique.length ? await queryByIds("User", ["Name", "IsActive"], unique) : [];
  return new Map(users.map((u) => [u.Id, { name: String(u.Name), active: u.IsActive === true }]));
}

function named(users: Map<string, { name: string }>, id: string) {
  return users.get(id)?.name ?? id;
}

/** Which requested IDs didn't come back from Salesforce? */
function missing(requested: string[], found: { Id: string }[]) {
  const foundIds = new Set(found.map((r) => r.Id));
  return requested.filter((id) => !foundIds.has(id));
}

/** Apply ownership moves, then read owners back and compare. */
async function applyMoves(operation: string, objectType: string, moves: Move[], extra: (m: Move) => Record<string, unknown> = () => ({})) {
  const audit = { attempted: true, verified: false, targetType: objectType };

  const results = await updateRecords(
    objectType,
    moves.map((m) => ({ Id: m.id, OwnerId: m.toOwnerId, ...extra(m) })),
  );
  const failures = failedSaves(results);
  if (failures.length > 0) {
    return makeErrorEnvelope({ operation, error: new Error(`${failures.length} record(s) failed to save.`), audit, data: { failures } });
  }

  const after = await queryByIds(objectType, ["OwnerId"], moves.map((m) => m.id));
  const ownerNow = new Map(after.map((r) => [r.Id, r.OwnerId]));
  const mismatches = moves.filter((m) => ownerNow.get(m.id) !== m.toOwnerId);

  if (mismatches.length > 0) {
    return makeErrorEnvelope({
      operation,
      error: new Error("Salesforce accepted the update, but some owners read back differently (an assignment rule or flow may have overridden them)."),
      audit,
      data: { mismatches: mismatches.map((m) => ({ id: m.id, wanted: m.toOwnerId, actual: ownerNow.get(m.id) })) },
    });
  }

  return makeEnvelope(operation, { ...audit, verified: true }, { updated: moves.length });
}

// ---------------------------------------------------------------------------
// Round robin
// ---------------------------------------------------------------------------

export const roundRobinOwners = defineCommitAction({
  name: "owners.round_robin",
  description:
    "Reassign record owners in rotation across a list of reps (e.g. deal out 40 new leads across 4 SDRs).",
  inputSchema: z.object({
    objectType: ownableObject,
    recordIds: idList(2000),
    ownerIds: idList(50).describe("The reps, in rotation order."),
    startIndex: z.number().int().min(0).optional().describe("Continue a rotation: use nextStartIndex from the last run."),
  }),
  async plan(input) {
    input.recordIds.forEach(assertSalesforceId);
    const rows = await queryByIds(input.objectType, ["Name", "OwnerId"], input.recordIds);
    const records = rows.map((r) => ({ id: r.Id, name: String(r.Name), ownerId: String(r.OwnerId) }));
    const users = await loadUsers([...input.ownerIds, ...records.map((r) => r.ownerId)]);
    const inactive = input.ownerIds.filter((id) => !users.get(id)?.active);

    const plan = planRoundRobin(records, input.ownerIds, input.startIndex ?? 0);

    return {
      targetType: input.objectType,
      summary: `Reassign ${plan.moves.length} ${input.objectType} record(s) across ${input.ownerIds.length} rep(s).`,
      preview: {
        byRep: input.ownerIds.map((id) => ({ rep: named(users, id), ...plan.perOwner[id] })),
        moves: plan.moves.slice(0, 100).map((m) => ({
          record: m.name,
          from: named(users, m.fromOwnerId),
          to: named(users, m.toOwnerId),
        })),
        movesShown: Math.min(plan.moves.length, 100),
        movesTotal: plan.moves.length,
        alreadyWithAssignedRep: plan.unchanged.length,
        notFound: missing(input.recordIds, rows),
        nextStartIndex: plan.nextStartIndex,
      },
      // Includes every record's CURRENT owner: if anyone reassigns one of
      // these records after the preview, the apply is refused.
      fingerprint: {
        objectType: input.objectType,
        ownerIds: input.ownerIds,
        startIndex: input.startIndex ?? 0,
        current: records.map((r) => [r.id, r.ownerId]).sort(),
      },
      blocked: inactive.length
        ? `These reps are inactive or don't exist: ${inactive.join(", ")}.`
        : plan.moves.length === 0
          ? "Every record already belongs to its assigned rep."
          : undefined,
      state: { moves: plan.moves },
    };
  },
  apply: (input, plan) => applyMoves("owners.round_robin.apply", input.objectType, plan.state.moves),
});

// ---------------------------------------------------------------------------
// Territories
// ---------------------------------------------------------------------------

const territoryRule = z.object({
  territory: z.string(),
  ownerId: z.string(),
  field: z.string().describe("Field to match on, e.g. BillingState or BillingPostalCode."),
  operator: z.enum(["equals", "in", "startsWith"]),
  values: z.array(z.string()).min(1),
});

export const assignTerritories = defineCommitAction({
  name: "territories.assign",
  description:
    "Assign records to territories by rules (e.g. BillingState in CA/OR/WA → West → owner X). " +
    "The first matching rule wins, so list specific rules before broad ones.",
  inputSchema: z.object({
    objectType: z.enum(["Account", "Lead"]),
    recordIds: idList(2000),
    rules: z.array(territoryRule).min(1).max(100),
    territoryField: z.string().optional().describe("Optional field to also stamp with the territory name, e.g. custom_field_example__c."),
  }),
  async plan(input) {
    input.recordIds.forEach(assertSalesforceId);
    const ruleFields = [...new Set(input.rules.map((r) => assertApiName(r.field)))];
    if (input.territoryField) assertApiName(input.territoryField);

    const fields = [...new Set(["Name", "OwnerId", ...ruleFields, ...(input.territoryField ? [input.territoryField] : [])])];
    const rows = await queryByIds(input.objectType, fields, input.recordIds);
    const records = rows.map((r) => ({
      id: r.Id,
      name: String(r.Name),
      ownerId: String(r.OwnerId),
      fields: Object.fromEntries(ruleFields.map((f) => [f, r[f] == null ? null : String(r[f])])),
      currentTerritory: input.territoryField ? ((r[input.territoryField] as string | null) ?? null) : null,
    }));

    const users = await loadUsers([...input.rules.map((r) => r.ownerId), ...records.map((r) => r.ownerId)]);
    const inactive = [...new Set(input.rules.map((r) => r.ownerId))].filter((id) => !users.get(id)?.active);
    const plan = planTerritories(records, input.rules, { setsTerritoryField: Boolean(input.territoryField) });

    return {
      targetType: input.objectType,
      summary: `Move ${plan.moves.length} ${input.objectType} record(s) into territories; ${plan.unmatched.length} match no rule.`,
      preview: {
        byTerritory: Object.entries(plan.byTerritory).map(([territory, t]) => ({
          territory,
          owner: named(users, t.ownerId),
          records: t.records,
          moving: t.moving,
        })),
        moves: plan.moves.slice(0, 100).map((m) => ({
          record: m.name,
          territory: m.territory,
          from: named(users, m.fromOwnerId),
          to: named(users, m.toOwnerId),
        })),
        movesTotal: plan.moves.length,
        alreadyCorrect: plan.unchanged.length,
        matchNoRule: plan.unmatched.map((r) => ({ record: r.name, id: r.id, owner: named(users, r.ownerId) })),
        notFound: missing(input.recordIds, rows),
      },
      fingerprint: {
        objectType: input.objectType,
        rules: input.rules,
        territoryField: input.territoryField ?? null,
        current: records.map((r) => [r.id, r.ownerId, r.fields, r.currentTerritory]).sort(),
      },
      blocked: inactive.length
        ? `These territory owners are inactive or don't exist: ${inactive.join(", ")}.`
        : plan.moves.length === 0
          ? "Nothing to change: every matched record already has the right owner and territory."
          : undefined,
      state: { moves: plan.moves },
    };
  },
  apply: (input, plan) =>
    applyMoves(
      "territories.assign.apply",
      input.objectType,
      plan.state.moves,
      (m) => (input.territoryField ? { [input.territoryField]: (m as Move & { territory: string }).territory } : {}),
    ),
});

// ---------------------------------------------------------------------------
// Campaign members
// ---------------------------------------------------------------------------

/** One new CampaignMember: either a contact or a lead. */
interface MemberRow {
  CampaignId: string;
  Status: string;
  ContactId?: string;
  LeadId?: string;
}

async function existingMemberIds(campaignId: string, field: "ContactId" | "LeadId", ids: string[]) {
  const found = new Set<string>();
  for (const group of chunk(ids, 200)) {
    const rows = await soql(
      `SELECT ${field} FROM CampaignMember WHERE CampaignId = ${soqlString(campaignId)} AND ${field} IN (${group.map(soqlString).join(",")})`,
    );
    rows.forEach((r) => found.add(String(r[field])));
  }
  return found;
}

export const addCampaignMembers = defineCommitAction({
  name: "campaign_members.add",
  description: "Add contacts and/or leads to a campaign with a given member status.",
  inputSchema: z.object({
    campaignId: z.string(),
    status: z.string().describe("Must be one of the campaign's member statuses, e.g. Sent or Responded."),
    contactIds: z.array(z.string()).max(2000).optional(),
    leadIds: z.array(z.string()).max(2000).optional(),
  }),
  async plan(input) {
    assertSalesforceId(input.campaignId);
    const contactIds = input.contactIds ?? [];
    const leadIds = input.leadIds ?? [];
    [...contactIds, ...leadIds].forEach(assertSalesforceId);

    const [campaign] = await soql(`SELECT Id, Name, IsActive, Status FROM Campaign WHERE Id = ${soqlString(input.campaignId)}`);
    const base = { targetType: "campaign_member", targetId: input.campaignId, targetName: campaign ? String(campaign.Name) : undefined };

    if (!campaign) {
      return { ...base, summary: "Campaign not found.", preview: {}, fingerprint: null, blocked: "No campaign has that ID.", state: { rows: [] as MemberRow[] } };
    }

    const statuses = (await soql(`SELECT Label FROM CampaignMemberStatus WHERE CampaignId = ${soqlString(input.campaignId)}`)).map((s) =>
      String(s.Label),
    );

    const contacts = contactIds.length ? await queryByIds("Contact", ["Name", "HasOptedOutOfEmail"], contactIds) : [];
    const leads = leadIds.length ? await queryByIds("Lead", ["Name", "HasOptedOutOfEmail", "IsConverted"], leadIds) : [];
    const contactMembers = await existingMemberIds(input.campaignId, "ContactId", contacts.map((c) => c.Id));
    const leadMembers = await existingMemberIds(input.campaignId, "LeadId", leads.map((l) => l.Id));

    const convertedLeads = leads.filter((l) => l.IsConverted === true);
    const addContacts = contacts.filter((c) => !contactMembers.has(c.Id));
    const addLeads = leads.filter((l) => !leadMembers.has(l.Id) && l.IsConverted !== true);
    const adding = [...addContacts, ...addLeads];

    const rows: MemberRow[] = [
      ...addContacts.map((c) => ({ CampaignId: input.campaignId, ContactId: c.Id, Status: input.status })),
      ...addLeads.map((l) => ({ CampaignId: input.campaignId, LeadId: l.Id, Status: input.status })),
    ];

    return {
      ...base,
      summary: `Add ${adding.length} people to "${String(campaign.Name)}" as "${input.status}".`,
      preview: {
        campaign: { name: campaign.Name, active: campaign.IsActive, status: campaign.Status },
        willAdd: adding.length,
        sample: adding.slice(0, 25).map((p) => p.Name),
        skipped: {
          alreadyMembers: contactMembers.size + leadMembers.size,
          convertedLeads: convertedLeads.length,
          notFound: [...missing(contactIds, contacts), ...missing(leadIds, leads)],
        },
        emailOptedOutAmongThem: adding.filter((p) => p.HasOptedOutOfEmail === true).length,
        note: "Campaign membership can trigger downstream automation (e.g. a HubSpot or Outreach sync). Check what listens to this campaign.",
      },
      fingerprint: { campaignId: input.campaignId, status: input.status, rows: rows.map((r) => [r.ContactId ?? "", r.LeadId ?? ""]).sort() },
      blocked: !statuses.includes(input.status)
        ? `"${input.status}" isn't a member status on this campaign. Options: ${statuses.join(", ")}.`
        : adding.length === 0
          ? "Nobody new to add."
          : undefined,
      state: { rows },
    };
  },
  async apply(input, plan) {
    const operation = "campaign_members.add.apply";
    const audit = { attempted: true, verified: false, targetType: "campaign_member", targetId: input.campaignId };
    const failures = failedSaves(await createRecords("CampaignMember", plan.state.rows));

    if (failures.length > 0) {
      return makeErrorEnvelope({ operation, error: new Error(`${failures.length} member(s) failed to save.`), audit, data: { failures } });
    }

    // Verify: every person we meant to add is now a member.
    const contactIds = plan.state.rows.flatMap((r) => (r.ContactId ? [r.ContactId] : []));
    const leadIds = plan.state.rows.flatMap((r) => (r.LeadId ? [r.LeadId] : []));
    const nowContacts = await existingMemberIds(input.campaignId, "ContactId", contactIds);
    const nowLeads = await existingMemberIds(input.campaignId, "LeadId", leadIds);
    const verified = nowContacts.size === contactIds.length && nowLeads.size === leadIds.length;

    return verified
      ? makeEnvelope(operation, { ...audit, verified }, { added: plan.state.rows.length })
      : makeErrorEnvelope({ operation, error: new Error("Some members didn't read back after saving."), audit });
  },
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const deleteSalesforceRecords = defineCommitAction({
  name: "records.delete",
  description: "Delete records. Salesforce keeps deleted records in the Recycle Bin for 15 days.",
  inputSchema: z.object({
    objectType: z.enum(["Lead", "Contact", "Account", "Opportunity", "Campaign"]),
    recordIds: idList(2000),
  }),
  async plan(input) {
    input.recordIds.forEach(assertSalesforceId);
    const rows = await queryByIds(input.objectType, ["Name"], input.recordIds);

    return {
      targetType: input.objectType,
      summary: `Delete ${rows.length} ${input.objectType} record(s).`,
      preview: {
        willDelete: rows.slice(0, 100).map((r) => ({ id: r.Id, name: r.Name })),
        total: rows.length,
        notFound: missing(input.recordIds, rows),
        restore: "Deleted records can be restored from the Recycle Bin for 15 days.",
        warning:
          input.objectType === "Account"
            ? "Deleting an Account also deletes its related Contacts, Opportunities, and Cases."
            : undefined,
      },
      fingerprint: { objectType: input.objectType, ids: rows.map((r) => r.Id).sort() },
      blocked: rows.length === 0 ? "None of these records exist." : undefined,
      state: { ids: rows.map((r) => r.Id) },
    };
  },
  async apply(input, plan) {
    const operation = "records.delete.apply";
    const audit = { attempted: true, verified: false, targetType: input.objectType };
    const failures = failedSaves(await deleteRecords(plan.state.ids));

    if (failures.length > 0) {
      return makeErrorEnvelope({ operation, error: new Error(`${failures.length} record(s) failed to delete.`), audit, data: { failures } });
    }

    const stillThere = await queryByIds(input.objectType, [], plan.state.ids);
    return stillThere.length === 0
      ? makeEnvelope(operation, { ...audit, verified: true }, { deleted: plan.state.ids.length })
      : makeErrorEnvelope({ operation, error: new Error("Some records still exist after delete."), audit, data: { stillThere } });
  },
});
