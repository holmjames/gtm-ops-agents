/**
 * HUBSPOT COMMIT ACTIONS
 *
 * The HubSpot actions that change what's live. Each one is split into
 * plan (look, change nothing) and apply (change, then verify). The shared
 * commit gate turns each into a `.preview` tool and an `.apply` tool. See
 * shared/tools/src/commitTools.ts.
 *
 * The apply steps reuse the original verified tools (workflowsSetEnabled,
 * listsDelete, ...), so the preview gate is layered ON TOP of the existing
 * read-back checks rather than replacing them.
 */

import { defineCommitAction } from "@gtm-ops/shared";
import { z } from "zod";
import { crmRecordMemberships, crmUpdateProperties, propertyText } from "./crm.js";
import { hubspotRequest } from "./hubspot.js";
import { listMembersAdd, listMembersRemove, listsDelete } from "./lists.js";
import type { CrmObjectType, WorkflowSummary } from "./types.js";
import { getWorkflow, resolveWorkflowTarget, workflowsDelete, workflowsSetEnabled } from "./workflows.js";

const crmObjectType = z.enum(["contacts", "companies", "deals", "tickets"]);

const workflowTarget = z.object({
  workflowId: z.string().optional(),
  workflowName: z.string().optional().describe("Exact workflow name (case-insensitive). Partial names are refused."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find exactly one workflow, or explain why we can't. */
async function loadWorkflowForCommit(input: { workflowId?: string; workflowName?: string }) {
  const { workflows, match } = await resolveWorkflowTarget(input);

  if (!match) {
    return {
      blocked: "No workflow matched exactly. Use the workflow ID, or its full exact name.",
      candidates: workflows.slice(0, 20).map((w: WorkflowSummary) => ({ id: w.id, name: w.name })),
    } as const;
  }

  const workflow = await getWorkflow(match.id);
  return { match, workflow } as const;
}

/** A readable outline of a workflow's steps: how many, and of what kind. */
function describeActions(workflow: Record<string, unknown>) {
  const actions = Array.isArray(workflow.actions) ? (workflow.actions as Record<string, unknown>[]) : [];
  const byType: Record<string, number> = {};

  for (const action of actions) {
    const key = String(action.actionTypeId ?? action.type ?? "unknown");
    byType[key] = (byType[key] ?? 0) + 1;
  }

  return { stepCount: actions.length, stepsByActionType: byType };
}

async function getList(listId: string) {
  const response = await hubspotRequest<{ list?: Record<string, unknown> }>(`/crm/v3/lists/${listId}`);
  return response.list ?? {};
}

function listSize(list: Record<string, unknown>) {
  const extra = (list.additionalProperties ?? {}) as Record<string, unknown>;
  const size = Number(extra.hs_list_size ?? list.size);
  return Number.isFinite(size) ? size : null;
}

const OBJECT_TYPE_BY_ID: Record<string, CrmObjectType> = {
  "0-1": "contacts",
  "0-2": "companies",
  "0-3": "deals",
  "0-5": "tickets",
};

/** Which of these records are already on the list? */
async function splitByMembership(listId: string, objectType: CrmObjectType, recordIds: string[]) {
  const members: string[] = [];
  const nonMembers: string[] = [];

  for (const id of recordIds) {
    const memberships = await crmRecordMemberships({ objectType, id });
    const onList = (memberships.results ?? []).some((m) => String(m.listId) === listId);
    (onList ? members : nonMembers).push(id);
  }

  return { members: members.sort(), nonMembers: nonMembers.sort() };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export const enableWorkflow = defineCommitAction({
  name: "workflows.enable",
  description:
    "Turn a workflow ON so it starts enrolling records and running its steps (which may send email).",
  inputSchema: workflowTarget,
  async plan(input) {
    const loaded = await loadWorkflowForCommit(input);

    if ("blocked" in loaded) {
      return {
        targetType: "workflow",
        summary: "No workflow selected.",
        preview: { candidates: loaded.candidates },
        fingerprint: null,
        blocked: loaded.blocked,
        state: null,
      };
    }

    const { match, workflow } = loaded;
    const alreadyOn = workflow.isEnabled === true;

    return {
      targetType: "workflow",
      targetId: match.id,
      targetName: match.name,
      summary: `Turn ON workflow "${match.name}". It will begin enrolling records that meet its criteria.`,
      preview: {
        workflow: { id: match.id, name: match.name, currentlyEnabled: workflow.isEnabled },
        enrollmentCriteria: workflow.enrollmentCriteria ?? null,
        reEnrollment: (workflow.enrollmentCriteria as Record<string, unknown> | undefined)?.shouldReEnroll ?? null,
        goal: workflow.goalFilterBranch ?? null,
        ...describeActions(workflow),
        reviewerChecklist: [
          "Are the enrollment criteria right? (Validate them with a probe list first; see hubspot/playbook.md.)",
          "Which steps send email, and to whom?",
          "Should records that ALREADY match be enrolled the moment this turns on?",
        ],
      },
      // If anyone edits the workflow after the preview, its revision changes
      // and the ticket stops working.
      fingerprint: { id: match.id, revisionId: workflow.revisionId ?? null, isEnabled: workflow.isEnabled },
      blocked: alreadyOn ? "This workflow is already on." : undefined,
      state: { workflowId: match.id },
    };
  },
  async apply(_input, plan) {
    return workflowsSetEnabled({ workflowId: plan.state!.workflowId, isEnabled: true });
  },
});

export const deleteWorkflowAction = defineCommitAction({
  name: "workflows.delete",
  description: "Delete a workflow.",
  inputSchema: workflowTarget,
  async plan(input) {
    const loaded = await loadWorkflowForCommit(input);

    if ("blocked" in loaded) {
      return {
        targetType: "workflow",
        summary: "No workflow selected.",
        preview: { candidates: loaded.candidates },
        fingerprint: null,
        blocked: loaded.blocked,
        state: null,
      };
    }

    const { match, workflow } = loaded;

    return {
      targetType: "workflow",
      targetId: match.id,
      targetName: match.name,
      summary: `Delete workflow "${match.name}" (${match.id}).`,
      preview: {
        workflow: { id: match.id, name: match.name },
        currentlyEnabled: workflow.isEnabled,
        warning:
          workflow.isEnabled === true
            ? "This workflow is LIVE. Deleting it stops it mid-run for anything currently enrolled."
            : undefined,
        ...describeActions(workflow),
      },
      fingerprint: { id: match.id, revisionId: workflow.revisionId ?? null, isEnabled: workflow.isEnabled },
      state: { workflowId: match.id },
    };
  },
  async apply(_input, plan) {
    return workflowsDelete({ workflowId: plan.state!.workflowId });
  },
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export const deleteList = defineCommitAction({
  name: "lists.delete",
  description: "Delete a list. HubSpot soft-deletes lists, so they can be restored for a limited time.",
  inputSchema: z.object({ listId: z.string() }),
  async plan(input) {
    const list = await getList(input.listId);

    return {
      targetType: "list",
      targetId: input.listId,
      targetName: String(list.name ?? ""),
      summary: `Delete list "${String(list.name)}" (${input.listId}).`,
      preview: {
        list: { id: input.listId, name: list.name, processingType: list.processingType },
        memberCount: listSize(list),
        note: "Any workflow using this list as a trigger or filter will stop matching these records.",
      },
      fingerprint: { listId: input.listId, updatedAt: list.updatedAt ?? null, size: listSize(list) },
      state: null,
    };
  },
  async apply(input) {
    return listsDelete({ listId: input.listId });
  },
});

const membershipInput = z.object({
  listId: z.string(),
  recordIds: z.array(z.string()).min(1).max(100),
});

async function planMembershipChange(input: { listId: string; recordIds: string[] }, mode: "add" | "remove") {
  const list = await getList(input.listId);
  const name = String(list.name ?? "");
  const base = { targetType: "list_membership", targetId: input.listId, targetName: name };

  if (list.processingType === "DYNAMIC") {
    return {
      ...base,
      summary: `"${name}" is a dynamic list.`,
      preview: {},
      fingerprint: null,
      blocked: "Dynamic lists pick their own members from filters. Change the filters instead.",
      state: { recordIds: [] as string[] },
    };
  }

  const objectType = OBJECT_TYPE_BY_ID[String(list.objectTypeId)];
  if (!objectType) {
    return {
      ...base,
      summary: "Unsupported list type.",
      preview: { objectTypeId: list.objectTypeId },
      fingerprint: null,
      blocked: "This list holds a record type these tools don't support.",
      state: { recordIds: [] as string[] },
    };
  }

  const { members, nonMembers } = await splitByMembership(input.listId, objectType, input.recordIds);
  const toChange = mode === "add" ? nonMembers : members;
  const skipped = mode === "add" ? members : nonMembers;

  return {
    ...base,
    summary: `${mode === "add" ? "Add" : "Remove"} ${toChange.length} ${objectType} ${mode === "add" ? "to" : "from"} "${name}".`,
    preview: {
      list: { id: input.listId, name, currentSize: listSize(list) },
      [mode === "add" ? "willAdd" : "willRemove"]: toChange,
      skipped: {
        count: skipped.length,
        reason: mode === "add" ? "already on the list" : "not on the list",
        ids: skipped,
      },
      note: "Workflows that trigger on membership in this list may enroll or unenroll these records.",
    },
    fingerprint: { listId: input.listId, mode, toChange },
    blocked: toChange.length === 0 ? `Nothing to ${mode}: every record is ${skipped.length ? "already in that state" : "missing"}.` : undefined,
    state: { recordIds: toChange },
  };
}

export const addListMembers = defineCommitAction({
  name: "lists.members.add",
  description: "Add records to a MANUAL (static) list.",
  inputSchema: membershipInput,
  plan: (input) => planMembershipChange(input, "add"),
  apply: (input, plan) => listMembersAdd({ listId: input.listId, recordIds: plan.state.recordIds }),
});

export const removeListMembers = defineCommitAction({
  name: "lists.members.remove",
  description: "Remove records from a MANUAL (static) list.",
  inputSchema: membershipInput,
  plan: (input) => planMembershipChange(input, "remove"),
  apply: (input, plan) => listMembersRemove({ listId: input.listId, recordIds: plan.state.recordIds }),
});

// ---------------------------------------------------------------------------
// CRM records
// ---------------------------------------------------------------------------

export const updateRecordProperties = defineCommitAction({
  name: "crm.update_properties",
  description: "Change property values on one CRM record.",
  inputSchema: z.object({
    objectType: crmObjectType,
    id: z.string(),
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  async plan(input) {
    const params = new URLSearchParams();
    for (const name of Object.keys(input.properties)) params.append("properties", name);

    const record = await hubspotRequest<{ properties?: Record<string, unknown> }>(
      `/crm/v3/objects/${input.objectType}/${input.id}?${params.toString()}`,
    );

    const changes = Object.entries(input.properties).map(([property, after]) => {
      const before = record.properties?.[property] ?? null;
      return { property, before, after, changes: propertyText(before) !== propertyText(after) };
    });
    const real = changes.filter((c) => c.changes);

    return {
      targetType: input.objectType,
      targetId: input.id,
      summary: `Change ${real.length} propert${real.length === 1 ? "y" : "ies"} on ${input.objectType} ${input.id}.`,
      preview: { beforeAndAfter: changes },
      // Includes the BEFORE values: if someone else edits the record after
      // the preview, the apply is refused instead of overwriting their change.
      fingerprint: { objectType: input.objectType, id: input.id, changes },
      blocked: real.length === 0 ? "Every property already has the requested value." : undefined,
      state: null,
    };
  },
  async apply(input) {
    return crmUpdateProperties(input);
  },
});

