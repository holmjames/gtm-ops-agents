import { hubspotRequest } from "./hubspot.js";
import { crmObjectTypeId, makeEnvelope, makeErrorEnvelope } from "./utils.js";
import type { CrmObjectType, ToolEnvelope } from "./types.js";

function objectPath(objectType: CrmObjectType) {
  return `/crm/v3/objects/${objectType}`;
}

/**
 * Search any standard CRM object. Three modes in one tool:
 *  - `id`           → fetch one record directly
 *  - `query`        → free-text search
 *  - `filterGroups` → structured property filters (OR of AND-groups)
 *
 * `count: true` is the quietly useful one: it requests the smallest possible
 * page and returns only `total`. That replaces the common workaround of
 * building a throwaway static list just to read its size.
 */
export async function crmSearch(input: {
  objectType: CrmObjectType;
  query?: string;
  id?: string;
  limit?: number;
  properties?: string[];
  filterGroups?: Array<Record<string, unknown>>;
  sorts?: Array<Record<string, unknown>>;
  after?: string;
  count?: boolean;
}): Promise<ToolEnvelope> {
  const operation = "crm.search";

  try {
    if (input.id) {
      const record = await hubspotRequest<Record<string, unknown>>(
        `${objectPath(input.objectType)}/${input.id}`,
      );

      return makeEnvelope(
        operation,
        { attempted: true, verified: true, targetType: input.objectType, targetId: input.id },
        { count: 1, results: [record] },
      );
    }

    const hasFilterGroups = Array.isArray(input.filterGroups) && input.filterGroups.length > 0;

    if (!input.query && !hasFilterGroups) {
      return makeErrorEnvelope({
        operation,
        error: new Error("crm.search requires query, id, or filterGroups."),
        audit: { attempted: false, verified: false, targetType: input.objectType },
      });
    }

    // count mode: caller only wants the total, so request the smallest page.
    const countMode = input.count === true;
    const body: Record<string, unknown> = {
      limit: countMode ? 1 : input.limit ?? 25,
      properties: input.properties ?? [],
    };

    if (input.query) {
      body.query = input.query;
    }

    if (hasFilterGroups) {
      body.filterGroups = input.filterGroups;
    }

    if (input.sorts?.length) {
      body.sorts = input.sorts;
    }

    if (input.after) {
      body.after = input.after;
    }

    const response = await hubspotRequest<{
      total?: number;
      results?: Record<string, unknown>[];
      paging?: { next?: { after?: string } };
    }>(`${objectPath(input.objectType)}/search`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const results = response.results ?? [];

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: input.objectType },
      {
        total: response.total ?? results.length,
        // In count mode we suppress the record payload; total is the answer.
        count: countMode ? 0 : results.length,
        results: countMode ? [] : results,
        after: response.paging?.next?.after,
      },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: input.objectType,
        targetId: input.id,
      },
    });
  }
}

export async function crmGet(input: {
  objectType: CrmObjectType;
  id: string;
  properties?: string[];
  associations?: string[];
}): Promise<ToolEnvelope> {
  const operation = "crm.get";
  const params = new URLSearchParams();

  for (const property of input.properties ?? []) {
    params.append("properties", property);
  }

  for (const association of input.associations ?? []) {
    params.append("associations", association);
  }

  try {
    const record = await hubspotRequest<Record<string, unknown>>(
      `${objectPath(input.objectType)}/${input.id}${params.toString() ? `?${params.toString()}` : ""}`,
    );

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: input.objectType, targetId: input.id },
      { record },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: input.objectType,
        targetId: input.id,
      },
    });
  }
}

/**
 * HubSpot stores every property value as text ("true", "42", "" for empty),
 * so compare values in that form.
 */
export function propertyText(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Patch properties on a single record, then read those properties back so the
 * caller can confirm the write landed (audit.verified).
 */
export async function crmUpdateProperties(input: {
  objectType: CrmObjectType;
  id: string;
  properties: Record<string, string | number | boolean | null>;
}): Promise<ToolEnvelope> {
  const operation = "crm.update_properties";

  try {
    await hubspotRequest<Record<string, unknown>>(
      `${objectPath(input.objectType)}/${input.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties: input.properties }),
      },
    );

    // Read back the SAME properties we just wrote (a plain GET only returns
    // HubSpot's default properties) and compare each one.
    const params = new URLSearchParams();
    for (const name of Object.keys(input.properties)) params.append("properties", name);

    const verified = await hubspotRequest<{ properties?: Record<string, unknown> }>(
      `${objectPath(input.objectType)}/${input.id}?${params.toString()}`,
    );
    const mismatches = Object.entries(input.properties)
      .filter(([name, value]) => propertyText(verified.properties?.[name]) !== propertyText(value))
      .map(([name, value]) => ({ property: name, wanted: value, actual: verified.properties?.[name] ?? null }));

    if (mismatches.length > 0) {
      return makeErrorEnvelope({
        operation,
        error: new Error("HubSpot accepted the update, but some properties read back differently."),
        audit: { attempted: true, verified: false, targetType: input.objectType, targetId: input.id },
        data: { mismatches, record: verified },
      });
    }

    return makeEnvelope(
      operation,
      { attempted: true, verified: true, targetType: input.objectType, targetId: input.id },
      { updatedProperties: input.properties, record: verified },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: input.objectType,
        targetId: input.id,
      },
      data: { attemptedProperties: input.properties },
    });
  }
}

export async function crmAssociationsGet(input: {
  objectType: CrmObjectType;
  id: string;
  toObjectType: CrmObjectType;
}): Promise<ToolEnvelope> {
  const operation = "crm.associations.get";

  try {
    const response = await hubspotRequest<{ results?: Record<string, unknown>[] }>(
      `/crm/v4/objects/${input.objectType}/${input.id}/associations/${input.toObjectType}`,
    );

    return makeEnvelope(
      operation,
      {
        attempted: true,
        verified: true,
        targetType: `${input.objectType}_association`,
        targetId: input.id,
      },
      { results: response.results ?? [] },
    );
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: {
        attempted: true,
        verified: false,
        targetType: `${input.objectType}_association`,
        targetId: input.id,
      },
    });
  }
}

/** Helper used by the lists module to verify membership changes per-record. */
export async function crmRecordMemberships(input: {
  objectType: CrmObjectType;
  id: string;
}) {
  return hubspotRequest<{ results?: Record<string, unknown>[] }>(
    `/crm/v3/lists/records/${crmObjectTypeId(input.objectType)}/${input.id}/memberships`,
  );
}
