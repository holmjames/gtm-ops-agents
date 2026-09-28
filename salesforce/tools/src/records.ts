/**
 * SALESFORCE RECORDS AND CAMPAIGNS: Read and Build tools
 *
 * Read:   a guarded SOQL query
 * Build:  create a campaign, switched off
 */

import { makeEnvelope, makeErrorEnvelope, type ToolEnvelope } from "@gtm-ops/shared";
import { sfRequest, soql, soqlString, type SaveResult } from "./salesforce.js";

// ---------------------------------------------------------------------------
// Read: guarded query
// ---------------------------------------------------------------------------

/**
 * Lets the agent look things up with SOQL, but only READ: a single SELECT,
 * with a row cap. The agent uses this to find record IDs before previewing
 * a commit action.
 */
export function guardSoql(query: string, maxRows = 2000) {
  const trimmed = query.trim();

  if (!/^select\s/i.test(trimmed)) throw new Error("Only SELECT queries are allowed.");
  if (trimmed.includes(";")) throw new Error("Only a single query is allowed.");
  if (/\bfor\s+update\b/i.test(trimmed)) throw new Error("FOR UPDATE locks records and isn't allowed.");

  const limit = trimmed.match(/\blimit\s+(\d+)\s*$/i);
  if (!limit) return { query: `${trimmed} LIMIT 200`, limit: 200 };
  if (Number(limit[1]) > maxRows) throw new Error(`LIMIT can be at most ${maxRows}.`);
  return { query: trimmed, limit: Number(limit[1]) };
}

export async function recordsQuery(input: { soql: string }): Promise<ToolEnvelope> {
  const operation = "records.query";

  try {
    const { query, limit } = guardSoql(input.soql);
    const records = await soql(query, limit);
    return makeEnvelope(operation, { attempted: false, verified: false, targetType: "query" }, { query, count: records.length, records });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: { attempted: false, verified: false, targetType: "query" } });
  }
}

// ---------------------------------------------------------------------------
// Build: campaigns
// ---------------------------------------------------------------------------

/**
 * Create a campaign that is NOT live: IsActive = false, Status = "Planned".
 * Refuses if a campaign with the same exact name already exists, since two
 * campaigns with one name is how attribution reports quietly go wrong.
 */
export async function campaignsCreate(input: {
  name: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  parentCampaignId?: string;
}): Promise<ToolEnvelope> {
  const operation = "campaigns.create";
  const audit = { attempted: false, verified: false, targetType: "campaign", targetName: input.name };

  try {
    const existing = await soql(`SELECT Id, Name, IsActive, Status FROM Campaign WHERE Name = ${soqlString(input.name)} LIMIT 5`);
    if (existing.length > 0) {
      return makeErrorEnvelope({
        operation,
        code: "name_taken",
        error: new Error(`A campaign named "${input.name}" already exists.`),
        audit,
        data: { existing },
      });
    }

    const created = await sfRequest<SaveResult>("/sobjects/Campaign", {
      method: "POST",
      body: JSON.stringify({
        Name: input.name,
        IsActive: false,
        Status: "Planned",
        ...(input.type ? { Type: input.type } : {}),
        ...(input.startDate ? { StartDate: input.startDate } : {}),
        ...(input.endDate ? { EndDate: input.endDate } : {}),
        ...(input.description ? { Description: input.description } : {}),
        ...(input.parentCampaignId ? { ParentId: input.parentCampaignId } : {}),
      }),
    });

    // Verify it exists AND that it's switched off.
    const [readback] = await soql(`SELECT Id, Name, IsActive, Status, Type FROM Campaign WHERE Id = ${soqlString(String(created.id))}`);
    const verified = Boolean(readback) && readback.Name === input.name && readback.IsActive === false;
    const doneAudit = { ...audit, attempted: true, verified, targetId: created.id };

    return verified
      ? makeEnvelope(operation, doneAudit, { campaign: readback })
      : makeErrorEnvelope({
          operation,
          error: new Error("The campaign was created but didn't read back as inactive with the right name."),
          audit: doneAudit,
          data: { campaign: readback ?? null },
        });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: { ...audit, attempted: true } });
  }
}
