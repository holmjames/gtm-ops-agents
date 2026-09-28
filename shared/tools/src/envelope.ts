/**
 * THE TOOL ENVELOPE
 *
 * Every tool in every operator (HubSpot, Salesforce, Outreach) answers in the
 * same shape. That consistency is what lets one agent drive three different
 * systems without learning three different ways of reporting success.
 *
 * The important part is `audit`:
 *   - `attempted`: did the tool actually try to change something?
 *   - `verified`:  did it then READ THE SYSTEM BACK and confirm the change is
 *                  really there?
 *
 * An API saying "200 OK" is not proof. `verified: true` is.
 */

export interface ToolAudit {
  attempted: boolean;
  verified: boolean;
  targetType: string;
  targetId?: string;
  targetName?: string;
}

export interface ToolErrorShape {
  code: string;
  message: string;
  raw?: unknown;
}

export interface ToolEnvelope {
  [key: string]: unknown;
  ok: boolean;
  operation: string;
  data?: Record<string, unknown>;
  error?: ToolErrorShape;
  audit: ToolAudit;
  unsupported_via_api?: boolean;
}

/**
 * A failed API call from any platform. Carries the HTTP status and the
 * platform's own error body, so the agent sees the real reason, not a
 * generic "something went wrong".
 */
export class ApiError extends Error {
  platform: string;
  status: number;
  raw: unknown;

  constructor(platform: string, status: number, statusText: string, raw: unknown) {
    const detail = typeof raw === "string" ? raw : JSON.stringify(raw ?? "Unknown error");
    super(`${platform} request failed (${status} ${statusText}): ${detail}`);
    this.name = "ApiError";
    this.platform = platform;
    this.status = status;
    this.raw = raw;
  }
}

/** Build a success envelope. */
export function makeEnvelope(
  operation: string,
  audit: ToolAudit,
  data?: Record<string, unknown>,
): ToolEnvelope {
  return { ok: true, operation, data, audit };
}

/**
 * Build a failure envelope. Works with any error that carries `status` and
 * `raw` (ApiError, or HubSpot's own HubSpotApiError), and with plain Errors.
 */
export function makeErrorEnvelope(input: {
  operation: string;
  error: unknown;
  audit: ToolAudit;
  data?: Record<string, unknown>;
  code?: string;
}): ToolEnvelope {
  const { error } = input;
  const withStatus = error as { status?: unknown; raw?: unknown; message?: unknown };
  const hasStatus = typeof withStatus?.status === "number";

  return {
    ok: false,
    operation: input.operation,
    data: input.data,
    error: {
      code: input.code ?? (hasStatus ? String(withStatus.status) : "unexpected_error"),
      message: error instanceof Error ? error.message : String(error),
      ...(hasStatus ? { raw: withStatus.raw } : {}),
    },
    audit: input.audit,
  };
}

/**
 * Turn an envelope into what an MCP client expects: a readable text block
 * plus the same data in structured form.
 */
export function toolResult(result: ToolEnvelope) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}
