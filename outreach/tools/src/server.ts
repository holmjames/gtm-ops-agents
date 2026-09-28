/**
 * OUTREACH OPERATOR: MCP server
 *
 * Publishes Outreach tools an AI agent can call, grouped by safety level
 * (see shared/guardrails.md):
 *
 *   Read    query, prospects.find_by_email
 *   Build   sequences.create (created off, nobody in it)
 *   Safe    sequences.deactivate (turning off never needs a preview)
 *   Commit  sequences.activate, sequences.enroll, sequence_states.change,
 *           records.delete. Each is a `.preview` + `.apply` pair behind the
 *           commit gate.
 *
 * Every tool answers with the same envelope, and every write reads Outreach
 * back before claiming success (audit.verified).
 */

import { CommitGate, loadRepoEnv, registerCommitAction, toolResult } from "@gtm-ops/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { activateSequence, changeSequenceStates, deleteOutreachRecords, enrollProspects } from "./commits.js";
import { setRepoRoot } from "./outreach.js";
import { prospectsFindByEmail, query, QUERYABLE, sequencesCreate, setSequenceEnabled } from "./tools.js";

// Credentials come from the repo-root .env; the rotating token file lives there too.
setRepoRoot(loadRepoEnv(import.meta.url).repoRoot);

const server = new McpServer({ name: "gtm-ops-outreach", version: "1.0.0" });

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

server.registerTool(
  "query",
  {
    description:
      "Read-only lookup across prospects, accounts, sequences, sequenceStates, sequenceSteps, mailboxes, users, or templates. " +
      'Filters use dotted names, e.g. { "sequence.id": 42, "state": "active" }.',
    inputSchema: z.object({
      resource: z.enum(QUERYABLE),
      filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      limit: z.number().int().positive().max(1000).optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await query(input)),
);

server.registerTool(
  "prospects.find_by_email",
  {
    description: "Look up prospects by email, with owner, opt-out status, and which sequences they're currently in.",
    inputSchema: z.object({ emails: z.array(z.string()).min(1).max(100) }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await prospectsFindByEmail(input)),
);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

server.registerTool(
  "sequences.create",
  {
    description:
      "Create a sequence switched OFF with nobody in it, including its steps and email copy. Refuses if the exact name exists. " +
      "Verified by reading back: off, zero prospects, all steps present.",
    inputSchema: z.object({
      name: z.string(),
      description: z.string().optional(),
      steps: z
        .array(
          z.object({
            type: z.enum(["auto_email", "manual_email", "call", "task"]),
            waitDays: z.number().min(0).describe("Days to wait before this step."),
            subject: z.string().optional(),
            bodyHtml: z.string().optional(),
            note: z.string().optional().describe("Instructions for call/task steps."),
          }),
        )
        .min(1)
        .max(20),
    }),
  },
  async (input) => toolResult(await sequencesCreate(input)),
);

server.registerTool(
  "sequences.deactivate",
  {
    description: "Turn a sequence OFF. Always allowed without a preview: it's the safe direction. Verified by readback.",
    inputSchema: z.object({ sequenceId: z.number().int().positive() }),
  },
  async (input) => toolResult(await setSequenceEnabled(input.sequenceId, false, "sequences.deactivate")),
);

// ---------------------------------------------------------------------------
// Commit (preview → human approval → apply)
// ---------------------------------------------------------------------------

const gate = new CommitGate();

registerCommitAction(server, gate, activateSequence);
registerCommitAction(server, gate, enrollProspects);
registerCommitAction(server, gate, changeSequenceStates);
registerCommitAction(server, gate, deleteOutreachRecords);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await server.connect(new StdioServerTransport());
