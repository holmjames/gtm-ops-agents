/**
 * THE COMMIT GATE (preview tickets)
 *
 * Some actions change what's live: turning on a workflow, enrolling prospects,
 * reassigning account owners, deleting records. We call these COMMIT actions.
 *
 * A commit action always runs in two steps:
 *
 *   1. PREVIEW: the tool looks at the current state of the system, works out
 *      exactly what WOULD happen, and returns that preview plus a short ticket
 *      (e.g. "ct_9f2c41a07b3e"). Nothing is changed.
 *
 *   2. APPLY: after a human approves the preview, the agent calls the apply
 *      tool with the same inputs and the ticket. The tool looks at the system
 *      AGAIN and only proceeds if what it sees still matches the preview.
 *
 * How "still matches" works: when the preview is made, we take a
 * "fingerprint" of everything that matters (which records, their current
 * owners, the workflow's revision number, and so on) and store a hash of it
 * against the ticket. At apply time we take the fingerprint again. If anything
 * changed in between (a new record matched, someone edited the workflow, the
 * inputs were different), the hashes don't match and the apply is refused.
 *
 * So the ticket guarantees: WHAT RUNS IS EXACTLY WHAT WAS APPROVED.
 *
 * Tickets are also single-use and expire (15 minutes by default), so an old
 * approval can't be replayed later.
 *
 * What the ticket does NOT do on its own is prove a human said yes. That's
 * the job of the agent's instructions (see shared/guardrails.md) and of your
 * MCP client's per-tool approval settings. Configure your client to always
 * ask before any `*.apply` tool runs.
 */

import { createHash, randomBytes } from "node:crypto";

export type RedeemFailure =
  | "unknown_ticket"
  | "expired"
  | "already_used"
  | "wrong_action"
  | "changed_since_preview";

export type RedeemResult =
  | { ok: true }
  | { ok: false; code: RedeemFailure; message: string };

interface IssuedTicket {
  action: string;
  fingerprintHash: string;
  expiresAt: number;
  used: boolean;
}

/**
 * Turn any value into a stable string: object keys are sorted, so
 * {a:1, b:2} and {b:2, a:1} produce the same fingerprint.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

export function fingerprintHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class CommitGate {
  private tickets = new Map<string, IssuedTicket>();
  private ttlMs: number;
  private now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Step 1: record what the preview saw, and hand back a ticket for it. */
  issue(action: string, fingerprint: unknown) {
    const ticket = `ct_${randomBytes(6).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;

    this.tickets.set(ticket, {
      action,
      fingerprintHash: fingerprintHash(fingerprint),
      expiresAt,
      used: false,
    });

    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Step 2: check a ticket against what the system looks like NOW.
   * Only a successful check uses the ticket up.
   */
  redeem(ticket: string, action: string, fingerprint: unknown): RedeemResult {
    const issued = this.tickets.get(ticket);

    if (!issued) {
      return {
        ok: false,
        code: "unknown_ticket",
        message: "This ticket was never issued (or the server restarted). Run the preview again.",
      };
    }

    if (issued.action !== action) {
      return {
        ok: false,
        code: "wrong_action",
        message: `This ticket was issued for "${issued.action}", not "${action}".`,
      };
    }

    if (issued.used) {
      return {
        ok: false,
        code: "already_used",
        message: "This ticket has already been used. Each approval covers exactly one apply.",
      };
    }

    if (this.now() > issued.expiresAt) {
      return {
        ok: false,
        code: "expired",
        message: "This ticket has expired. Run the preview again and get a fresh approval.",
      };
    }

    if (issued.fingerprintHash !== fingerprintHash(fingerprint)) {
      return {
        ok: false,
        code: "changed_since_preview",
        message:
          "Something changed since the preview was approved (the inputs, or the live data). " +
          "Nothing was applied. Review the new preview and approve again.",
      };
    }

    issued.used = true;
    return { ok: true };
  }
}
