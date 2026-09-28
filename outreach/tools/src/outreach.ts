/**
 * OUTREACH CONNECTION
 *
 * The one place that talks to Outreach's API (v2, which uses the "JSON:API"
 * format: every record is { type, id, attributes, relationships }).
 * Logging in is handled by auth.ts.
 */

import path from "node:path";
import { ApiError, chunk, requireEnv } from "@gtm-ops/shared";
import { OutreachAuth } from "./auth.js";

const API_BASE = "https://api.outreach.io/api/v2";

let auth: OutreachAuth | null = null;
let repoRoot = process.cwd();

export function setRepoRoot(root: string | null) {
  if (root) repoRoot = root;
}

function getAuth() {
  auth ??= new OutreachAuth({
    tokenFile: path.resolve(repoRoot, process.env.OUTREACH_TOKEN_FILE ?? ".outreach-token.json"),
    clientId: requireEnv("OUTREACH_CLIENT_ID"),
    clientSecret: requireEnv("OUTREACH_CLIENT_SECRET"),
    redirectUri: requireEnv("OUTREACH_REDIRECT_URI"),
  });
  return auth;
}

export async function outreachRequest<T>(pathAndQuery: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = retried ? await getAuth().forceRefresh() : await getAuth().getAccessToken();
  const response = await fetch(`${API_BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.api+json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  // The access token was rejected: refresh once, then give up loudly.
  if (response.status === 401 && !retried) {
    return outreachRequest<T>(pathAndQuery, init, true);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON. Keep the raw text.
  }

  if (!response.ok) throw new ApiError("Outreach", response.status, response.statusText, body);
  return body as T;
}

// ---------------------------------------------------------------------------
// JSON:API helpers
// ---------------------------------------------------------------------------

export interface JsonApiRecord {
  type: string;
  id: number;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: number } | { type: string; id: number }[] | null }>;
}

export interface JsonApiList {
  data: JsonApiRecord[];
  meta?: { count?: number };
  links?: { next?: string };
}

/** Flatten a record to { id, type, ...attributes, ownerId, sequenceId, … } for readability. */
export function flatten(record: JsonApiRecord) {
  const related: Record<string, unknown> = {};
  for (const [name, rel] of Object.entries(record.relationships ?? {})) {
    if (rel?.data && !Array.isArray(rel.data)) related[`${name}Id`] = rel.data.id;
  }
  return { id: record.id, type: record.type, ...record.attributes, ...related };
}

export function relatedId(record: JsonApiRecord, name: string) {
  const data = record.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : null;
}

/** Filter keys like "sequence.id" become filter[sequence][id]. Checked, never passed through raw. */
export function filterParam(key: string) {
  if (!/^[A-Za-z]+(\.[A-Za-z]+)*$/.test(key)) throw new Error(`"${key}" is not a valid filter name.`);
  return `filter${key.split(".").map((part) => `[${part}]`).join("")}`;
}

export function buildQuery(filters: Record<string, string | number | boolean | (string | number)[]>, pageSize: number) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    params.set(filterParam(key), Array.isArray(value) ? value.join(",") : String(value));
  }
  params.set("page[size]", String(pageSize));
  return params.toString();
}

export async function list(resource: string, filters: Record<string, string | number | boolean | (string | number)[]>, pageSize = 100) {
  return outreachRequest<JsonApiList>(`/${resource}?${buildQuery(filters, pageSize)}`);
}

/** Like `list`, but follows Outreach's "next page" links until done (or `max`). */
export async function listAll(resource: string, filters: Record<string, string | number | boolean | (string | number)[]>, max = 2000) {
  const out: JsonApiRecord[] = [];
  let page = await list(resource, filters, 100);

  while (true) {
    out.push(...page.data);
    if (!page.links?.next || out.length >= max) break;
    page = await outreachRequest<JsonApiList>(page.links.next.replace(API_BASE, ""));
  }

  return out.slice(0, max);
}

/** Fetch many records by a filter on ID lists, 50 IDs per request. */
export async function listByIds(resource: string, ids: number[], idFilter = "id") {
  const out: JsonApiRecord[] = [];
  for (const group of chunk(ids, 50)) {
    out.push(...(await listAll(resource, { [idFilter]: group })));
  }
  return out;
}

/** How many records match? Uses Outreach's count metadata, with a fallback. */
export async function count(resource: string, filters: Record<string, string | number | boolean | (string | number)[]>) {
  const result = await list(resource, filters, 1);
  return result.meta?.count ?? result.data.length;
}

export function rel(type: string, id: number) {
  return { data: { type, id } };
}
