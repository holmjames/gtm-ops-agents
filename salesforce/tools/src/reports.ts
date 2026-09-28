/**
 * SALESFORCE REPORTS
 *
 * Read:   find reports, run a report
 * Build:  create reports by COPYING a known-good template
 *
 * The lesson this code is built around: Salesforce's reporting API rejects
 * some report types outright and fails loudly on others. Building a report
 * from scratch is fragile. Copying one that already works and changing only
 * the filters is reliable. So there is no "create from scratch" tool here.
 */

import { makeEnvelope, makeErrorEnvelope, type ToolEnvelope } from "@gtm-ops/shared";
import { chunkFilterValues } from "./plans.js";
import { assertSalesforceId, sfRequest, soql, soqlString } from "./salesforce.js";

interface ReportFilter {
  column: string;
  operator: string;
  value: string;
}

interface ReportMetadata {
  id?: string;
  name?: string;
  folderId?: string;
  detailColumns?: string[];
  reportFilters?: ReportFilter[];
  reportBooleanFilter?: string | null;
  [key: string]: unknown;
}

interface ReportResult {
  attributes?: { reportId?: string };
  reportMetadata?: ReportMetadata;
  reportExtendedMetadata?: { detailColumnInfo?: Record<string, { label?: string }> };
  factMap?: Record<string, { rows?: { dataCells: { label?: string; value?: unknown }[] }[] }>;
  allData?: boolean;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function reportsSearch(input: { query?: string; folderName?: string; limit?: number }): Promise<ToolEnvelope> {
  const operation = "reports.search";
  const where: string[] = [];

  if (input.query) where.push(`Name LIKE ${soqlString(`%${input.query}%`)}`);
  if (input.folderName) where.push(`FolderName = ${soqlString(input.folderName)}`);

  try {
    const reports = await soql(
      `SELECT Id, Name, DeveloperName, FolderName, Format, LastRunDate, LastModifiedDate FROM Report` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY LastModifiedDate DESC LIMIT ${Math.min(input.limit ?? 50, 200)}`,
    );

    return makeEnvelope(operation, { attempted: false, verified: false, targetType: "report" }, { count: reports.length, reports });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: { attempted: false, verified: false, targetType: "report" } });
  }
}

/** Turn Salesforce's nested report result into simple rows the agent can read. */
export function flattenReport(result: ReportResult, maxRows = 200) {
  const columns = result.reportMetadata?.detailColumns ?? [];
  const labels = columns.map((c) => result.reportExtendedMetadata?.detailColumnInfo?.[c]?.label ?? c);
  const rows: Record<string, unknown>[] = [];
  let totalRows = 0;

  for (const block of Object.values(result.factMap ?? {})) {
    for (const row of block.rows ?? []) {
      totalRows += 1;
      if (rows.length < maxRows) {
        rows.push(Object.fromEntries(row.dataCells.map((cell, i) => [labels[i] ?? `col${i}`, cell.label ?? cell.value])));
      }
    }
  }

  return { columns: labels, rowCount: totalRows, rows, truncated: totalRows > rows.length, allDataReturned: result.allData ?? true };
}

export async function runReport(reportId: string) {
  assertSalesforceId(reportId);
  return sfRequest<ReportResult>(`/analytics/reports/${reportId}?includeDetails=true`);
}

export async function reportsRun(input: { reportId: string; maxRows?: number }): Promise<ToolEnvelope> {
  const operation = "reports.run";

  try {
    const result = await runReport(input.reportId);
    const table = flattenReport(result, input.maxRows ?? 200);

    return makeEnvelope(
      operation,
      { attempted: false, verified: false, targetType: "report", targetId: input.reportId, targetName: result.reportMetadata?.name },
      table,
    );
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: { attempted: false, verified: false, targetType: "report", targetId: input.reportId } });
  }
}

// ---------------------------------------------------------------------------
// Build: copy a template
// ---------------------------------------------------------------------------

async function describeReport(reportId: string) {
  const described = await sfRequest<{ reportMetadata: ReportMetadata }>(`/analytics/reports/${reportId}/describe`);
  return described.reportMetadata;
}

/** Did the saved report end up with the name and filters we asked for? */
function filtersMatch(saved: ReportFilter[] = [], wanted: ReportFilter[]) {
  return wanted.every((w) =>
    saved.some((s) => s.column === w.column && s.operator === w.operator && String(s.value) === String(w.value)),
  );
}

export async function reportsCloneFromTemplate(input: {
  templateReportId: string;
  newName: string;
  folderId?: string;
  extraFilters?: ReportFilter[];
  idFilter?: { column: string; ids: string[] };
}): Promise<ToolEnvelope> {
  const operation = "reports.clone_from_template";
  const audit = { attempted: false, verified: false, targetType: "report", targetName: input.newName };

  try {
    assertSalesforceId(input.templateReportId);
    const template = await describeReport(input.templateReportId);
    const addingFilters = (input.extraFilters?.length ?? 0) > 0 || Boolean(input.idFilter);

    // Templates with custom filter logic ("1 AND (2 OR 3)") would leave any
    // new filter out of that logic. Refuse rather than guess how to fit it in.
    if (addingFilters && template.reportBooleanFilter) {
      return makeErrorEnvelope({
        operation,
        code: "template_has_filter_logic",
        error: new Error(
          `Template uses custom filter logic (${template.reportBooleanFilter}). Pick a template without it, or add the filters by hand.`,
        ),
        audit,
      });
    }

    // A long ID filter becomes several reports, each under the length limit.
    const idGroups = input.idFilter ? chunkFilterValues(input.idFilter.ids) : [null];
    const created: Record<string, unknown>[] = [];

    for (const [i, ids] of idGroups.entries()) {
      const name = idGroups.length > 1 ? `${input.newName} (${i + 1} of ${idGroups.length})` : input.newName;
      const wantedFilters: ReportFilter[] = [
        ...(input.extraFilters ?? []),
        ...(ids && input.idFilter ? [{ column: input.idFilter.column, operator: "equals", value: ids.join(",") }] : []),
      ];

      // 1. Copy the template under the new name.
      const copy = await sfRequest<ReportResult>(`/analytics/reports?cloneId=${input.templateReportId}`, {
        method: "POST",
        body: JSON.stringify({ reportMetadata: { name, ...(input.folderId ? { folderId: input.folderId } : {}) } }),
      });
      const newId = copy.reportMetadata?.id ?? copy.attributes?.reportId;
      if (!newId) throw new Error("Salesforce copied the report but didn't return its new ID.");

      // 2. Add our filters on top of the template's own filters.
      if (wantedFilters.length > 0) {
        await sfRequest(`/analytics/reports/${newId}`, {
          method: "PATCH",
          body: JSON.stringify({
            reportMetadata: { reportFilters: [...(template.reportFilters ?? []), ...wantedFilters] },
          }),
        });
      }

      // 3. Verify: read the saved report back, then actually run it.
      const saved = await describeReport(newId);
      const result = await runReport(newId);
      const nameOk = saved.name === name;
      const filtersOk = filtersMatch(saved.reportFilters, wantedFilters);

      created.push({
        reportId: newId,
        name,
        verified: nameOk && filtersOk,
        ...(nameOk ? {} : { nameMismatch: { wanted: name, actual: saved.name } }),
        ...(filtersOk ? {} : { filtersSaved: saved.reportFilters }),
        rowCount: flattenReport(result, 0).rowCount,
      });
    }

    const allVerified = created.every((c) => c.verified === true);
    const envelopeAudit = { ...audit, attempted: true, verified: allVerified, targetId: String(created[0]?.reportId ?? "") };

    return allVerified
      ? makeEnvelope(operation, envelopeAudit, { templateReportId: input.templateReportId, created })
      : makeErrorEnvelope({
          operation,
          error: new Error("Report(s) were created, but at least one didn't read back as requested."),
          audit: envelopeAudit,
          data: { created },
        });
  } catch (error) {
    return makeErrorEnvelope({ operation, error, audit: { ...audit, attempted: true } });
  }
}
