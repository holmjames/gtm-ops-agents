/**
 * SALESFORCE OPERATOR: MCP server
 *
 * Publishes Salesforce tools an AI agent can call, grouped by safety level
 * (see shared/guardrails.md):
 *
 *   Read    reports.search, reports.run, records.query
 *   Build   reports.clone_from_template, campaigns.create (created inactive)
 *   Commit  owners.round_robin, territories.assign, campaign_members.add,
 *           records.delete. Each is a `.preview` + `.apply` pair behind
 *           the commit gate.
 *
 * Every tool answers with the same envelope, and every write reads
 * Salesforce back before claiming success (audit.verified).
 */

import { CommitGate, loadRepoEnv, registerCommitAction, toolResult } from "@gtm-ops/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { addCampaignMembers, assignTerritories, deleteSalesforceRecords, roundRobinOwners } from "./commits.js";
import { campaignsCreate, recordsQuery } from "./records.js";
import { reportsCloneFromTemplate, reportsRun, reportsSearch } from "./reports.js";

loadRepoEnv(import.meta.url);

const server = new McpServer({ name: "gtm-ops-salesforce", version: "1.0.0" });

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

server.registerTool(
  "reports.search",
  {
    description: "Find reports by name and/or folder.",
    inputSchema: z.object({
      query: z.string().optional(),
      folderName: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await reportsSearch(input)),
);

server.registerTool(
  "reports.run",
  {
    description: "Run a report and return its rows as a simple table.",
    inputSchema: z.object({ reportId: z.string(), maxRows: z.number().int().min(0).max(2000).optional() }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await reportsRun(input)),
);

server.registerTool(
  "records.query",
  {
    description: "Run a read-only SOQL SELECT (single query, max 2000 rows). Use it to find record IDs before previewing a commit action.",
    inputSchema: z.object({ soql: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await recordsQuery(input)),
);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const reportFilter = z.object({ column: z.string(), operator: z.string(), value: z.string() });

server.registerTool(
  "reports.clone_from_template",
  {
    description:
      "Create a report by copying a known-good template and adding filters. A long ID filter is automatically " +
      "split across several reports ('… (1 of 3)') to stay under Salesforce's filter length limit. Each new report is read back and run to verify.",
    inputSchema: z.object({
      templateReportId: z.string(),
      newName: z.string(),
      folderId: z.string().optional(),
      extraFilters: z.array(reportFilter).optional(),
      idFilter: z.object({ column: z.string(), ids: z.array(z.string()).min(1) }).optional(),
    }),
  },
  async (input) => toolResult(await reportsCloneFromTemplate(input)),
);

server.registerTool(
  "campaigns.create",
  {
    description: "Create a campaign switched off (IsActive = false, Status = Planned). Refuses if the exact name already exists.",
    inputSchema: z.object({
      name: z.string(),
      type: z.string().optional(),
      startDate: z.string().optional().describe("YYYY-MM-DD"),
      endDate: z.string().optional().describe("YYYY-MM-DD"),
      description: z.string().optional(),
      parentCampaignId: z.string().optional(),
    }),
  },
  async (input) => toolResult(await campaignsCreate(input)),
);

// ---------------------------------------------------------------------------
// Commit (preview → human approval → apply)
// ---------------------------------------------------------------------------

const gate = new CommitGate();

registerCommitAction(server, gate, roundRobinOwners);
registerCommitAction(server, gate, assignTerritories);
registerCommitAction(server, gate, addCampaignMembers);
registerCommitAction(server, gate, deleteSalesforceRecords);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await server.connect(new StdioServerTransport());
