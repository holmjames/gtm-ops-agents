import { requireEnv } from "./config.js";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

/**
 * Typed wrapper around a non-2xx HubSpot response. Carries the parsed body so
 * callers can branch on `status` / inspect `raw` (HubSpot returns useful
 * structured validation errors that we want to surface verbatim).
 */
export class HubSpotApiError extends Error {
  status: number;
  statusText: string;
  raw: unknown;

  constructor(status: number, statusText: string, raw: unknown) {
    const message =
      typeof raw === "string" ? raw : JSON.stringify(raw ?? "Unknown HubSpot error");

    super(`HubSpot request failed (${status} ${statusText}): ${message}`);
    this.name = "HubSpotApiError";
    this.status = status;
    this.statusText = statusText;
    this.raw = raw;
  }
}

/**
 * The single choke point for every HubSpot API call. Injects the private-app
 * bearer token, forces `no-store` so we never serve stale CRM state, and
 * normalizes errors into HubSpotApiError. Every tool in this server goes
 * through here — there is no other place that touches the network.
 */
export async function hubspotRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = requireEnv("HUBSPOT_ACCESS_TOKEN");
  const response = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    let raw: unknown = text;

    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        // Response body is not JSON (e.g. an HTML error page); keep raw text.
      }
    }

    throw new HubSpotApiError(response.status, response.statusText, raw);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
