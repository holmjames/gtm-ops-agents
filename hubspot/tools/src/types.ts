// The shared response shape (ok / operation / data / audit) lives in
// shared/tools/src/envelope.ts so all three operators answer the same way.
export type { ToolAudit, ToolEnvelope, ToolErrorShape } from "@gtm-ops/shared";

export type CrmObjectType = "contacts" | "companies" | "deals" | "tickets";

export interface WorkflowSummary {
  id: string;
  name?: string;
  isEnabled?: boolean;
  objectTypeId?: string;
  revisionId?: string;
  type?: string;
  flowType?: string;
}
