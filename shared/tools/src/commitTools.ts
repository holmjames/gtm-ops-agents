/**
 * COMMIT TOOLS: how a commit action becomes two MCP tools
 *
 * Each platform describes a commit action once, with two functions:
 *
 *   plan(input):   look at the live system and work out exactly what would
 *                  happen. Returns a human-readable preview, plus a
 *                  fingerprint of everything that must not change before apply.
 *                  Must NOT change anything.
 *
 *   apply(input):  make the change, then read the system back to verify it.
 *
 * `registerCommitAction` then publishes two tools to the agent:
 *
 *   <name>.preview   runs plan(), issues a ticket.       Safe; changes nothing.
 *   <name>.apply     re-runs plan(), checks the ticket,   Changes live data.
 *                    and only then runs apply().
 *
 * Because the agent can only reach apply() through this wrapper, there is no
 * way to skip the preview, reuse an old approval, or apply something different
 * from what was previewed.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CommitGate } from "./commitGate.js";
import { makeEnvelope, makeErrorEnvelope, toolResult, type ToolEnvelope } from "./envelope.js";

export interface CommitPlan<State = unknown> {
  targetType: string;
  targetId?: string;
  targetName?: string;
  /** One plain-English sentence, e.g. "Move 40 accounts across 4 reps." */
  summary: string;
  /** What the human should see before approving: counts, before/after, exclusions. */
  preview: Record<string, unknown>;
  /** Everything that must be identical at apply time. Hashed, never shown. */
  fingerprint: unknown;
  /** If set, there's nothing safe to apply (e.g. zero eligible prospects). */
  blocked?: string;
  /** Working data apply() needs (already-fetched records, etc.). Not shown. */
  state: State;
}

export interface CommitAction<Shape extends z.ZodRawShape, State = unknown> {
  /** e.g. "workflows.enable" → tools "workflows.enable.preview" / ".apply" */
  name: string;
  /** What the action does, in one or two sentences, for the agent. */
  description: string;
  inputSchema: z.ZodObject<Shape>;
  plan(input: z.infer<z.ZodObject<Shape>>): Promise<CommitPlan<State>>;
  apply(
    input: z.infer<z.ZodObject<Shape>>,
    plan: CommitPlan<State>,
  ): Promise<ToolEnvelope>;
}

/** Identity helper, so each action gets full type checking where it's written. */
export function defineCommitAction<Shape extends z.ZodRawShape, State>(
  action: CommitAction<Shape, State>,
) {
  return action;
}

function auditFor(plan: Pick<CommitPlan, "targetType" | "targetId" | "targetName">) {
  return {
    attempted: false,
    verified: false,
    targetType: plan.targetType,
    targetId: plan.targetId,
    targetName: plan.targetName,
  };
}

export async function runPreview<Shape extends z.ZodRawShape, State>(
  gate: CommitGate,
  action: CommitAction<Shape, State>,
  input: z.infer<z.ZodObject<Shape>>,
): Promise<ToolEnvelope> {
  const operation = `${action.name}.preview`;

  try {
    const plan = await action.plan(input);

    if (plan.blocked) {
      return makeErrorEnvelope({
        operation,
        code: "nothing_to_apply",
        error: new Error(plan.blocked),
        audit: auditFor(plan),
        data: { summary: plan.summary, preview: plan.preview },
      });
    }

    const { ticket, expiresAt } = gate.issue(action.name, plan.fingerprint);

    return makeEnvelope(operation, auditFor(plan), {
      summary: plan.summary,
      preview: plan.preview,
      ticket,
      expiresAt,
      nextStep:
        `Nothing has changed yet. Show this preview to a human. Only if they explicitly ` +
        `approve it, call ${action.name}.apply with the same inputs and this ticket.`,
    });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: auditFor({ targetType: action.name }) });
  }
}

export async function runApply<Shape extends z.ZodRawShape, State>(
  gate: CommitGate,
  action: CommitAction<Shape, State>,
  input: z.infer<z.ZodObject<Shape>> & { ticket: string },
): Promise<ToolEnvelope> {
  const operation = `${action.name}.apply`;
  const { ticket, ...actionInput } = input;

  try {
    // Look at the live system again. Don't trust anything from the preview.
    const plan = await action.plan(actionInput as z.infer<z.ZodObject<Shape>>);

    if (plan.blocked) {
      return makeErrorEnvelope({
        operation,
        code: "nothing_to_apply",
        error: new Error(plan.blocked),
        audit: auditFor(plan),
        data: { summary: plan.summary, preview: plan.preview },
      });
    }

    const check = gate.redeem(ticket, action.name, plan.fingerprint);

    if (!check.ok) {
      return makeErrorEnvelope({
        operation,
        code: check.code,
        error: new Error(check.message),
        audit: auditFor(plan),
        // Show what the system looks like now, so the human can re-approve.
        data: { currentSummary: plan.summary, currentPreview: plan.preview },
      });
    }

    return await action.apply(actionInput as z.infer<z.ZodObject<Shape>>, plan);
  } catch (error) {
    return makeErrorEnvelope({
      operation,
      error,
      audit: { ...auditFor({ targetType: action.name }), attempted: true },
    });
  }
}

/** Publish a commit action to an MCP server as `.preview` + `.apply` tools. */
export function registerCommitAction<Shape extends z.ZodRawShape, State>(
  server: McpServer,
  gate: CommitGate,
  action: CommitAction<Shape, State>,
) {
  type Input = z.infer<z.ZodObject<Shape>>;

  server.registerTool(
    `${action.name}.preview`,
    {
      description:
        `PREVIEW ONLY, changes nothing. ${action.description} ` +
        `Returns exactly what would happen plus a ticket that ${action.name}.apply requires.`,
      inputSchema: action.inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (raw: unknown) => toolResult(await runPreview(gate, action, raw as Input)),
  );

  server.registerTool(
    `${action.name}.apply`,
    {
      description:
        `COMMIT: changes live data. ${action.description} ` +
        `Requires the ticket from ${action.name}.preview AND a human's explicit approval of ` +
        `that preview. Refuses if anything changed since the preview.`,
      inputSchema: action.inputSchema.extend({
        ticket: z.string().describe(`The ticket returned by ${action.name}.preview.`),
      }),
      annotations: { destructiveHint: true },
    },
    async (raw: unknown) =>
      toolResult(await runApply(gate, action, raw as Input & { ticket: string })),
  );
}
