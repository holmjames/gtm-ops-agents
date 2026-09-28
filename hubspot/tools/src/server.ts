/**
 * HUBSPOT OPERATOR: MCP server
 *
 * Publishes HubSpot tools an AI agent can call, grouped by safety level
 * (see shared/guardrails.md):
 *
 *   Read    search / get workflows, lists, and records
 *   Build   create workflows switched off, set their criteria and steps,
 *           create lists
 *   Commit  turn workflows on, delete, change list membership, edit records.
 *           Each is a `.preview` + `.apply` pair behind the commit gate.
 *
 * Every tool answers with the same envelope, and every write reads the
 * system back before claiming success (audit.verified).
 */
import { CommitGate, registerCommitAction, toolResult } from "@gtm-ops/shared";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import "./config.js";
import {
  addListMembers,
  deleteList,
  deleteWorkflowAction,
  enableWorkflow,
  removeListMembers,
  updateRecordProperties,
} from "./commits.js";
import { crmAssociationsGet, crmGet, crmSearch } from "./crm.js";
import {
  listMembersList,
  listsCreate,
  listsGet,
  listsRename,
  listsSearch,
  listsUpdateFilters,
} from "./lists.js";
import {
  workflowsAddGoToWorkflowStep,
  workflowsCloneBasic,
  workflowsCreateManual,
  workflowsGet,
  workflowsRename,
  workflowsSearch,
  workflowsSetActions,
  workflowsSetEnabled,
  workflowsSetEnrollmentCriteria,
  workflowsSetGoalCriteria,
} from "./workflows.js";

const server = new McpServer({
  name: "gtm-ops-hubspot",
  version: "1.0.0",
});

const crmObjectType = z.enum(["contacts", "companies", "deals", "tickets"]);

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

server.registerTool(
  "workflows.search",
  {
    description: "Search or list workflows by exact name, partial name, or ID.",
    inputSchema: z.object({
      query: z.string().optional(),
      workflowId: z.string().optional(),
      exactName: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await workflowsSearch(input)),
);

server.registerTool(
  "workflows.get",
  {
    description: "Fetch full workflow details by workflow ID.",
    inputSchema: z.object({ workflowId: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await workflowsGet(input)),
);

server.registerTool(
  "workflows.create_manual",
  {
    description:
      "Create an empty, disabled contact workflow shell. Configure it with set_enrollment_criteria / set_actions.",
    inputSchema: z.object({ name: z.string(), description: z.string().optional() }),
  },
  async (input) => toolResult(await workflowsCreateManual(input)),
);

server.registerTool(
  "workflows.set_enrollment_criteria",
  {
    description:
      "Set who is enrolled in a workflow. Takes a raw HubSpot v4 enrollmentCriteria filter branch.",
    inputSchema: z.object({
      workflowId: z.string(),
      enrollmentCriteria: z.record(z.string(), z.unknown()),
    }),
  },
  async (input) => toolResult(await workflowsSetEnrollmentCriteria(input)),
);

server.registerTool(
  "workflows.set_actions",
  {
    description:
      "Replace a workflow's action graph. Auto-derives startActionId from the first action.",
    inputSchema: z.object({
      workflowId: z.string(),
      actions: z.array(z.record(z.string(), z.unknown())),
      startActionId: z.string().optional(),
    }),
  },
  async (input) => toolResult(await workflowsSetActions(input)),
);

server.registerTool(
  "workflows.set_goal_criteria",
  {
    description: "Set a workflow's goal (goalFilterBranch) — the condition that marks contacts converted.",
    inputSchema: z.object({
      workflowId: z.string(),
      goalFilterBranch: z.record(z.string(), z.unknown()),
    }),
  },
  async (input) => toolResult(await workflowsSetGoalCriteria(input)),
);

server.registerTool(
  "workflows.rename",
  {
    description: "Rename a workflow, targeted by ID or exact name.",
    inputSchema: z.object({
      workflowId: z.string().optional(),
      workflowName: z.string().optional(),
      newName: z.string(),
    }),
  },
  async (input) => toolResult(await workflowsRename(input)),
);

// Turning a workflow OFF is always allowed without a preview: it's the safe
// direction, and in an emergency it needs to be one step. Turning one ON is
// a commit action (workflows.enable.preview / .apply, registered below).
server.registerTool(
  "workflows.disable",
  {
    description: "Turn a workflow OFF, targeted by ID or exact name. Verified by readback.",
    inputSchema: z.object({
      workflowId: z.string().optional(),
      workflowName: z.string().optional(),
    }),
  },
  async (input) => toolResult(await workflowsSetEnabled({ ...input, isEnabled: false })),
);

server.registerTool(
  "workflows.clone_basic",
  {
    description: "Clone a workflow's criteria + steps into a new disabled workflow.",
    inputSchema: z.object({
      sourceWorkflowId: z.string().optional(),
      sourceWorkflowName: z.string().optional(),
      newName: z.string(),
    }),
  },
  async (input) => toolResult(await workflowsCloneBasic(input)),
);

server.registerTool(
  "workflows.add_go_to_workflow_step",
  {
    description:
      "Append a 'go to other workflow' step. Flags unsupported_via_api when the portal rejects the step type.",
    inputSchema: z.object({
      sourceWorkflowId: z.string(),
      targetWorkflowId: z.string(),
    }),
  },
  async (input) => toolResult(await workflowsAddGoToWorkflowStep(input)),
);

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

server.registerTool(
  "lists.search",
  {
    description: "Search lists by name / object type / processing type.",
    inputSchema: z.object({
      query: z.string().optional(),
      objectType: crmObjectType.optional(),
      objectTypeId: z.string().optional(),
      processingTypes: z.array(z.enum(["MANUAL", "DYNAMIC", "SNAPSHOT"])).optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await listsSearch(input)),
);

server.registerTool(
  "lists.get",
  {
    description: "Fetch a list by ID. Pass includeFilters to read its filterBranch back.",
    inputSchema: z.object({ listId: z.string(), includeFilters: z.boolean().optional() }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await listsGet(input)),
);

server.registerTool(
  "lists.create",
  {
    description: "Create a list (DYNAMIC by default) with an optional raw filterBranch.",
    inputSchema: z.object({
      name: z.string(),
      objectType: crmObjectType.optional(),
      objectTypeId: z.string().optional(),
      processingType: z.enum(["MANUAL", "DYNAMIC", "SNAPSHOT"]).optional(),
      filterBranch: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  async (input) => toolResult(await listsCreate(input)),
);

server.registerTool(
  "lists.update_filters",
  {
    description:
      "Replace an existing dynamic list's filterBranch in place (full replace, not merge). Reads it back to verify.",
    inputSchema: z.object({
      listId: z.string(),
      filterBranch: z.record(z.string(), z.unknown()),
    }),
  },
  async (input) => toolResult(await listsUpdateFilters(input)),
);

server.registerTool(
  "lists.rename",
  {
    description: "Rename a list, verified by readback.",
    inputSchema: z.object({ listId: z.string(), name: z.string() }),
  },
  async (input) => toolResult(await listsRename(input)),
);

server.registerTool(
  "lists.members.list",
  {
    description: "List a list's memberships.",
    inputSchema: z.object({ listId: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await listMembersList(input)),
);

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

server.registerTool(
  "crm.search",
  {
    description:
      "Search a standard CRM object by query, id, or structured filterGroups. Pass count:true to return only the total.",
    inputSchema: z.object({
      objectType: crmObjectType,
      query: z.string().optional(),
      id: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
      properties: z.array(z.string()).optional(),
      filterGroups: z.array(z.record(z.string(), z.unknown())).optional(),
      sorts: z.array(z.record(z.string(), z.unknown())).optional(),
      after: z.string().optional(),
      count: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await crmSearch(input)),
);

server.registerTool(
  "crm.get",
  {
    description: "Fetch one CRM record with optional properties and associations.",
    inputSchema: z.object({
      objectType: crmObjectType,
      id: z.string(),
      properties: z.array(z.string()).optional(),
      associations: z.array(z.string()).optional(),
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await crmGet(input)),
);

server.registerTool(
  "crm.associations.get",
  {
    description: "Fetch associated records of another object type for a CRM record.",
    inputSchema: z.object({
      objectType: crmObjectType,
      id: z.string(),
      toObjectType: crmObjectType,
    }),
    annotations: { readOnlyHint: true },
  },
  async (input) => toolResult(await crmAssociationsGet(input)),
);

// ---------------------------------------------------------------------------
// Commit actions: each becomes a `.preview` tool and an `.apply` tool.
// Apply only works with a ticket from a preview, and only if nothing changed.
// See shared/guardrails.md and shared/tools/src/commitGate.ts.
// ---------------------------------------------------------------------------

const gate = new CommitGate();

registerCommitAction(server, gate, enableWorkflow);
registerCommitAction(server, gate, deleteWorkflowAction);
registerCommitAction(server, gate, deleteList);
registerCommitAction(server, gate, addListMembers);
registerCommitAction(server, gate, removeListMembers);
registerCommitAction(server, gate, updateRecordProperties);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
