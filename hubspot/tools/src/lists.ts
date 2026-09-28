import { hubspotRequest, HubSpotApiError } from "./hubspot.js";
import { crmRecordMemberships } from "./crm.js";
import { crmObjectTypeId, makeEnvelope, makeErrorEnvelope } from "./utils.js";
import type { CrmObjectType, ToolEnvelope } from "./types.js";

function resolveObjectTypeId(input?: { objectType?: CrmObjectType; objectTypeId?: string }) {
  if (input?.objectTypeId) {
    return input.objectTypeId;
  }

  if (input?.objectType) {
    return crmObjectTypeId(input.objectType);
  }

  return undefined;
}

async function getListObjectTypeId(listId: string) {
  const response = await hubspotRequest<{ list?: Record<string, unknown> }>(
    `/crm/v3/lists/${listId}`,
  );
  const list = response.list ?? {};

  return typeof list.objectTypeId === "string" ? list.objectTypeId : undefined;
}

export async function listsSearch(input: {
  query?: string;
  objectType?: CrmObjectType;
  objectTypeId?: string;
  processingTypes?: Array<"MANUAL" | "DYNAMIC" | "SNAPSHOT">;
}): Promise<ToolEnvelope> {
  const operation = "lists.search";
  const body: Record<string, unknown> = {};
  const objectTypeId = resolveObjectTypeId(input);

  if (input.query) {
    body.query = input.query;
  }

  if (objectTypeId) {
    body.objectTypeId = objectTypeId;
  }

  if (input.processingTypes?.length) {
    body.processingTypes = input.processingTypes;
  }

  try {
    const response = await hubspotRequest<{ total?: number; lists?: Record<string, unknown>[] }>(
      "/crm/v3/lists/search",
      { method: "POST", body: JSON.stringify(body) },
    );

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: "list" },
      { total: response.total ?? response.lists?.length ?? 0, lists: response.lists ?? [] },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: { attempted: true, verified: false, targetType: "list" },
    });
  }
}

/**
 * Create a list. A DYNAMIC list takes a raw `filterBranch` (the same nested
 * AND/OR property-filter tree used by workflow enrollment) and HubSpot keeps it
 * continuously up to date. Defaults to a contacts DYNAMIC list.
 */
export async function listsCreate(input: {
  name: string;
  objectTypeId?: string;
  objectType?: CrmObjectType;
  processingType?: "MANUAL" | "DYNAMIC" | "SNAPSHOT";
  filterBranch?: Record<string, unknown>;
}): Promise<ToolEnvelope> {
  const operation = "lists.create";
  const objectTypeId = resolveObjectTypeId(input) ?? "0-1";
  const body: Record<string, unknown> = {
    name: input.name,
    objectTypeId,
    processingType: input.processingType ?? "DYNAMIC",
  };

  if (input.filterBranch) {
    body.filterBranch = input.filterBranch;
  }

  try {
    const response = await hubspotRequest<{ list?: Record<string, unknown> }>("/crm/v3/lists/", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const list = response.list ?? {};
    const listId = typeof list.listId === "string" ? list.listId : undefined;

    return makeEnvelope(
      operation,
      {
        attempted: true,
        verified: true,
        targetType: "list",
        targetId: listId,
        targetName: typeof list.name === "string" ? list.name : input.name,
      },
      { request: body, list },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: { attempted: true, verified: false, targetType: "list", targetName: input.name },
      data: { request: body },
    });
  }
}

/**
 * Edit an EXISTING dynamic list's filters in place (same listId). The branch is
 * FULLY REPLACED, not merged — to add a group, read the current branch via
 * lists.get(includeFilters), append, and pass the whole thing back.
 *
 * Important nuance: HubSpot can *accept* an invalid filterBranch and silently
 * store it as "always false". A 200 is therefore not proof. We read the branch
 * back as a minimum sanity check, and the README documents validating against a
 * throwaway list (which returns precise errors + a real member count) before
 * trusting a complex filter.
 */
export async function listsUpdateFilters(input: {
  listId: string;
  filterBranch: Record<string, unknown>;
}): Promise<ToolEnvelope> {
  const operation = "lists.update_filters";
  const body = { filterBranch: input.filterBranch };

  try {
    const response = await hubspotRequest<{
      updatedList?: Record<string, unknown>;
      list?: Record<string, unknown>;
    }>(`/crm/v3/lists/${input.listId}/update-list-filters`, {
      method: "PUT",
      body: JSON.stringify(body),
    });

    const updated = response.updatedList ?? response.list ?? {};

    let readbackFilterBranch: unknown;
    try {
      const readback = await hubspotRequest<{ list?: Record<string, unknown> }>(
        `/crm/v3/lists/${input.listId}?includeFilters=true`,
      );
      readbackFilterBranch = readback.list?.filterBranch;
    } catch {
      // Readback is best-effort; the PUT already succeeded.
    }

    return makeEnvelope(
      operation,
      {
        attempted: true,
        verified: Boolean(readbackFilterBranch),
        targetType: "list",
        targetId: input.listId,
        targetName: typeof updated.name === "string" ? updated.name : undefined,
      },
      { request: body, list: updated, readbackFilterBranch },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: { attempted: true, verified: false, targetType: "list", targetId: input.listId },
      data: { request: body },
    });
  }
}

export async function listsRename(input: {
  listId: string;
  name: string;
}): Promise<ToolEnvelope> {
  const operation = "lists.rename";

  try {
    await hubspotRequest<{ list?: Record<string, unknown> }>(
      `/crm/v3/lists/${input.listId}/update-list-name?listName=${encodeURIComponent(input.name)}`,
      { method: "PUT" },
    );

    const readback = await hubspotRequest<{ list?: Record<string, unknown> }>(
      `/crm/v3/lists/${input.listId}`,
    );
    const newName = typeof readback.list?.name === "string" ? readback.list.name : undefined;

    return makeEnvelope(
      operation,
      {
        attempted: true,
        verified: newName === input.name,
        targetType: "list",
        targetId: input.listId,
        targetName: newName,
      },
      { list: readback.list ?? {} },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: "list",
        targetId: input.listId,
        targetName: input.name,
      },
    });
  }
}

export async function listsDelete(input: { listId: string }): Promise<ToolEnvelope> {
  const operation = "lists.delete";

  try {
    await hubspotRequest<void>(`/crm/v3/lists/${input.listId}`, { method: "DELETE" });

    // HubSpot soft-deletes lists: a follow-up GET may 404, or return the list
    // flagged with a deletedAt timestamp. Treat either as verified removal.
    let verified = false;
    let detail: Record<string, unknown> | undefined;

    try {
      const readback = await hubspotRequest<{ list?: Record<string, unknown> }>(
        `/crm/v3/lists/${input.listId}`,
      );
      detail = readback.list;
      verified = Boolean(readback.list?.deletedAt ?? readback.list?.deleted ?? false);
    } catch (readbackError) {
      if (readbackError instanceof HubSpotApiError && readbackError.status === 404) {
        verified = true;
      } else {
        throw readbackError;
      }
    }

    return makeEnvelope(
      operation,
      { attempted: true, verified, targetType: "list", targetId: input.listId },
      { deletedListId: input.listId, detail },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: { attempted: true, verified: false, targetType: "list", targetId: input.listId },
    });
  }
}

export async function listsGet(input: {
  listId: string;
  includeFilters?: boolean;
}): Promise<ToolEnvelope> {
  const operation = "lists.get";
  const path = input.includeFilters
    ? `/crm/v3/lists/${input.listId}?includeFilters=true`
    : `/crm/v3/lists/${input.listId}`;

  try {
    const response = await hubspotRequest<{ list?: Record<string, unknown> }>(path);

    return makeEnvelope(
      operation,
      {
        attempted: true,
        verified: true,
        targetType: "list",
        targetId: input.listId,
        targetName: typeof response.list?.name === "string" ? response.list.name : undefined,
      },
      { list: response.list ?? {} },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: { attempted: true, verified: false, targetType: "list", targetId: input.listId },
    });
  }
}

export async function listMembersList(input: { listId: string }): Promise<ToolEnvelope> {
  const operation = "lists.members.list";

  try {
    const response = await hubspotRequest<{ results?: Record<string, unknown>[] }>(
      `/crm/v3/lists/${input.listId}/memberships`,
    );

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: "list_membership", targetId: input.listId },
      { results: response.results ?? [] },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: "list_membership",
        targetId: input.listId,
      },
    });
  }
}

/**
 * Confirm a membership change actually took effect by re-reading each record's
 * memberships and checking whether the list is (or is no longer) present. This
 * is what lets members.add / members.remove report a trustworthy
 * audit.verified instead of relying on the mutation's status code.
 */
async function verifyMemberships(listId: string, recordIds: string[], shouldExist: boolean) {
  const objectTypeId = await getListObjectTypeId(listId);

  if (!objectTypeId) {
    return false;
  }

  const objectTypeMap: Record<string, CrmObjectType> = {
    "0-1": "contacts",
    "0-2": "companies",
    "0-3": "deals",
    "0-5": "tickets",
  };
  const objectType = objectTypeMap[objectTypeId];

  if (!objectType) {
    return false;
  }

  const verifications = await Promise.all(
    recordIds.map(async (recordId) => {
      const memberships = await crmRecordMemberships({ objectType, id: recordId });
      const listPresent = (memberships.results ?? []).some(
        (membership) =>
          typeof membership.listId === "string" && membership.listId === listId,
      );

      return shouldExist ? listPresent : !listPresent;
    }),
  );

  return verifications.every(Boolean);
}

export async function listMembersAdd(input: {
  listId: string;
  recordIds: string[];
}): Promise<ToolEnvelope> {
  const operation = "lists.members.add";

  try {
    await hubspotRequest<void>(`/crm/v3/lists/${input.listId}/memberships/add`, {
      method: "PUT",
      body: JSON.stringify(input.recordIds),
    });
    const verified = await verifyMemberships(input.listId, input.recordIds, true);

    if (!verified) {
      return makeErrorEnvelope({
        operation,
        error: new Error("List add completed but membership verification was inconclusive."),
        audit: {
          attempted: true,
          verified: false,
          targetType: "list_membership",
          targetId: input.listId,
        },
        data: { recordIds: input.recordIds },
      });
    }

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: "list_membership", targetId: input.listId },
      { recordIds: input.recordIds },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: "list_membership",
        targetId: input.listId,
      },
      data: { recordIds: input.recordIds },
    });
  }
}

export async function listMembersRemove(input: {
  listId: string;
  recordIds: string[];
}): Promise<ToolEnvelope> {
  const operation = "lists.members.remove";

  try {
    await hubspotRequest<void>(`/crm/v3/lists/${input.listId}/memberships/remove`, {
      method: "PUT",
      body: JSON.stringify(input.recordIds),
    });
    const verified = await verifyMemberships(input.listId, input.recordIds, false);

    if (!verified) {
      return makeErrorEnvelope({
        operation,
        error: new Error("List remove completed but membership verification was inconclusive."),
        audit: {
          attempted: true,
          verified: false,
          targetType: "list_membership",
          targetId: input.listId,
        },
        data: { recordIds: input.recordIds },
      });
    }

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: "list_membership", targetId: input.listId },
      { recordIds: input.recordIds },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: "list_membership",
        targetId: input.listId,
      },
      data: { recordIds: input.recordIds },
    });
  }
}
