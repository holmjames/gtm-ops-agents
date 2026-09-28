import { HubSpotApiError } from "./hubspot.js";
import type { CrmObjectType, ToolAudit, ToolEnvelope, WorkflowSummary } from "./types.js";

// HubSpot's standard CRM object type IDs. Custom objects use a "2-XXXXXXXX"
// form; this demo sticks to the standard objects.
const CRM_OBJECT_TYPE_IDS: Record<CrmObjectType, string> = {
  contacts: "0-1",
  companies: "0-2",
  deals: "0-3",
  tickets: "0-5",
};

export function crmObjectTypeId(objectType: CrmObjectType) {
  return CRM_OBJECT_TYPE_IDS[objectType];
}

export function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Resolve a single workflow by id, or by an EXACT (case-insensitive) name match.
 * Mutating tools refuse to act on a fuzzy/partial name — operating on the wrong
 * workflow is the most expensive mistake this server could make, so the target
 * must be unambiguous.
 */
export function exactWorkflowMatch(
  workflows: WorkflowSummary[],
  input: { workflowId?: string; workflowName?: string },
) {
  if (input.workflowId) {
    return workflows.find((workflow) => workflow.id === input.workflowId) ?? null;
  }

  if (!input.workflowName) {
    return null;
  }

  const target = normalizeText(input.workflowName);

  return (
    workflows.find(
      (workflow) => workflow.name && normalizeText(workflow.name) === target,
    ) ?? null
  );
}

export function makeEnvelope(
  operation: string,
  audit: ToolAudit,
  data?: Record<string, unknown>,
): ToolEnvelope {
  return {
    ok: true,
    operation,
    data,
    audit,
  };
}

export function makeErrorEnvelope(input: {
  operation: string;
  error: unknown;
  audit: ToolAudit;
  unsupportedViaApi?: boolean;
  data?: Record<string, unknown>;
}) {
  const { error } = input;

  if (error instanceof HubSpotApiError) {
    return {
      ok: false,
      operation: input.operation,
      data: input.data,
      error: {
        code: String(error.status),
        message: error.message,
        raw: error.raw,
      },
      audit: input.audit,
      ...(input.unsupportedViaApi ? { unsupported_via_api: true } : {}),
    } satisfies ToolEnvelope;
  }

  return {
    ok: false,
    operation: input.operation,
    data: input.data,
    error: {
      code: "unexpected_error",
      message: error instanceof Error ? error.message : "Unexpected error",
      raw: error,
    },
    audit: input.audit,
    ...(input.unsupportedViaApi ? { unsupported_via_api: true } : {}),
  } satisfies ToolEnvelope;
}

export function toolTextResult(result: ToolEnvelope) {
  return JSON.stringify(result, null, 2);
}

/**
 * Workflow action IDs are stringified integers that must be unique within a
 * flow. Prefer HubSpot's own `nextAvailableActionId`; otherwise derive the next
 * id from the current max so we never collide with an existing action.
 */
export function nextActionIdFromWorkflow(workflow: Record<string, unknown>) {
  if (typeof workflow.nextAvailableActionId === "string") {
    return workflow.nextAvailableActionId;
  }

  const actions = Array.isArray(workflow.actions) ? workflow.actions : [];
  const numericIds = actions
    .map((action) => {
      if (
        typeof action !== "object" ||
        action === null ||
        typeof (action as { actionId?: unknown }).actionId !== "string"
      ) {
        return null;
      }

      const parsed = Number.parseInt((action as { actionId: string }).actionId, 10);

      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter((value): value is number => value !== null);

  return numericIds.length === 0 ? "1" : String(Math.max(...numericIds) + 1);
}

/**
 * HubSpot's v4 flow API is read-modify-write: to change one field you PUT the
 * whole flow back. These helpers strip the server-managed fields that the API
 * rejects on write (ids, timestamps, revisionId) so the rest of the flow
 * survives a round-trip untouched.
 */
export function sanitizeWorkflowForCreate(
  workflow: Record<string, unknown>,
  overrides: { name?: string; isEnabled?: boolean } = {},
): Record<string, unknown> {
  const {
    id,
    revisionId,
    createdAt,
    updatedAt,
    dataSources,
    uuid,
    ...rest
  } = workflow;

  return {
    ...rest,
    ...(overrides.name ? { name: overrides.name } : {}),
    ...(typeof overrides.isEnabled === "boolean"
      ? { isEnabled: overrides.isEnabled }
      : {}),
  };
}

export function sanitizeWorkflowForUpdate(
  workflow: Record<string, unknown>,
  overrides: { name?: string; isEnabled?: boolean } = {},
): Record<string, unknown> {
  const { createdAt, updatedAt, dataSources, ...rest } = workflow;

  return {
    ...rest,
    ...(overrides.name ? { name: overrides.name } : {}),
    ...(typeof overrides.isEnabled === "boolean"
      ? { isEnabled: overrides.isEnabled }
      : {}),
  };
}
