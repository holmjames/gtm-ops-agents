/**
 * SALESFORCE CONNECTION
 *
 * The one place that talks to Salesforce. Every tool goes through
 * `sfRequest`, so logging in, retries on an expired session, and error
 * handling live here and nowhere else.
 *
 * Login uses the OAuth "client credentials" flow: a Connected App in your
 * org with a dedicated integration user. Use a Developer Edition org or a
 * sandbox, never production, while trying this out.
 */

import { ApiError, chunk, requireEnv } from "@gtm-ops/shared";

const API_VERSION = "v62.0";

let session: { accessToken: string; instanceUrl: string } | null = null;

async function login() {
  const instanceUrl = requireEnv("SALESFORCE_INSTANCE_URL").replace(/\/$/, "");
  const response = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: requireEnv("SALESFORCE_CLIENT_ID"),
      client_secret: requireEnv("SALESFORCE_CLIENT_SECRET"),
    }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError("Salesforce", response.status, response.statusText, body);
  }

  session = {
    accessToken: String(body.access_token),
    instanceUrl: String(body.instance_url ?? instanceUrl),
  };
  return session;
}

/**
 * Call the Salesforce REST API. `path` is relative to /services/data/vXX.X,
 * e.g. "/sobjects/Campaign" or "/analytics/reports/00O...".
 */
export async function sfRequest<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const current = session ?? (await login());
  const response = await fetch(`${current.instanceUrl}/services/data/${API_VERSION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${current.accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  // Sessions expire. Log in again once, then give up loudly.
  if (response.status === 401 && !retried) {
    session = null;
    return sfRequest<T>(path, init, true);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON (e.g. an HTML error page). Keep the raw text.
  }

  if (!response.ok) {
    throw new ApiError("Salesforce", response.status, response.statusText, body);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// SOQL (Salesforce's query language), done safely
// ---------------------------------------------------------------------------

/**
 * Anything we put inside a SOQL string must be escaped, or a value like
 * O'Brien breaks the query (or worse, changes what it means).
 */
export function soqlString(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Salesforce record IDs are 15 or 18 letters/digits. Reject anything else. */
export function assertSalesforceId(id: string) {
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) {
    throw new Error(`"${id}" is not a valid Salesforce record ID.`);
  }
  return id;
}

/** Field and object names can't be escaped, only checked. */
export function assertApiName(name: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/.test(name)) {
    throw new Error(`"${name}" is not a valid Salesforce field or object name.`);
  }
  return name;
}

export type SfRecord = Record<string, unknown> & { Id: string };

/** Run a SOQL query and follow pagination until done (or `max` reached). */
export async function soql<T extends Record<string, unknown> = SfRecord>(query: string, max = 2000): Promise<T[]> {
  const out: T[] = [];
  let page = await sfRequest<{ records: T[]; done: boolean; nextRecordsUrl?: string }>(
    `/query?q=${encodeURIComponent(query)}`,
  );

  while (true) {
    out.push(...page.records.map(stripAttributes));
    if (page.done || !page.nextRecordsUrl || out.length >= max) break;
    const nextPath = page.nextRecordsUrl.replace(/^\/services\/data\/v[\d.]+/, "");
    page = await sfRequest(nextPath);
  }

  return out.slice(0, max);
}

/** Fetch records by ID, 200 at a time, so long ID lists don't overflow the URL. */
export async function queryByIds(objectType: string, fields: string[], ids: string[]) {
  assertApiName(objectType);
  fields.forEach(assertApiName);
  ids.forEach(assertSalesforceId);

  const results: SfRecord[] = [];
  for (const group of chunk(ids, 200)) {
    const inList = group.map(soqlString).join(",");
    results.push(...(await soql(`SELECT ${["Id", ...fields.filter((f) => f !== "Id")].join(", ")} FROM ${objectType} WHERE Id IN (${inList})`)));
  }
  return results;
}

/** Salesforce adds an `attributes` block to every record; the agent doesn't need it. */
function stripAttributes<T extends Record<string, unknown>>(record: T): T {
  const { attributes, ...rest } = record as Record<string, unknown>;
  return rest as T;
}

// ---------------------------------------------------------------------------
// Bulk writes (the "composite" API: up to 200 records per call)
// ---------------------------------------------------------------------------

export interface SaveResult {
  id?: string;
  success: boolean;
  errors?: { statusCode?: string; message?: string; fields?: string[] }[];
}

/** Update many records. allOrNone: if one record in a batch fails, none in it change. */
export async function updateRecords(objectType: string, records: (Record<string, unknown> & { Id: string })[]) {
  const results: SaveResult[] = [];
  for (const group of chunk(records, 200)) {
    results.push(
      ...(await sfRequest<SaveResult[]>("/composite/sobjects", {
        method: "PATCH",
        body: JSON.stringify({
          allOrNone: true,
          records: group.map((r) => ({ attributes: { type: objectType }, ...r })),
        }),
      })),
    );
  }
  return results;
}

export async function createRecords(objectType: string, records: object[]) {
  const results: SaveResult[] = [];
  for (const group of chunk(records, 200)) {
    results.push(
      ...(await sfRequest<SaveResult[]>("/composite/sobjects", {
        method: "POST",
        body: JSON.stringify({
          allOrNone: true,
          records: group.map((r) => ({ attributes: { type: objectType }, ...r })),
        }),
      })),
    );
  }
  return results;
}

export async function deleteRecords(ids: string[]) {
  ids.forEach(assertSalesforceId);
  const results: SaveResult[] = [];
  for (const group of chunk(ids, 200)) {
    results.push(
      ...(await sfRequest<SaveResult[]>(`/composite/sobjects?allOrNone=true&ids=${group.join(",")}`, {
        method: "DELETE",
      })),
    );
  }
  return results;
}

export function failedSaves(results: SaveResult[]) {
  return results.filter((r) => !r.success);
}
