/**
 * OUTREACH PLANNING LOGIC (pure: no network calls)
 *
 * Who is allowed into a sequence, and which sequence-state changes make
 * sense. Kept separate from the API calls so it can be tested with made-up
 * data. See plans.test.ts.
 */

export interface ProspectFacts {
  id: number;
  name: string;
  optedOut: boolean;
  /** Sequence IDs this prospect is currently active/pending/paused in. */
  activeSequenceIds: number[];
  /** Sequence IDs this prospect has EVER been in (any state). */
  allSequenceIds: number[];
}

export type ExclusionReason = "opted_out" | "already_in_this_sequence" | "active_in_another_sequence" | "not_found";

/**
 * Decide who can be enrolled. Every excluded prospect gets a reason, so the
 * preview can say "12 excluded: 8 opted out, 4 already in another sequence"
 * instead of silently shrinking the list.
 */
export function planEnrollment(
  requestedIds: number[],
  prospects: ProspectFacts[],
  sequenceId: number,
  opts: { allowActiveElsewhere: boolean },
) {
  const byId = new Map(prospects.map((p) => [p.id, p]));
  const eligible: ProspectFacts[] = [];
  const excluded: { id: number; name?: string; reason: ExclusionReason }[] = [];

  for (const id of [...new Set(requestedIds)].sort((a, b) => a - b)) {
    const p = byId.get(id);

    if (!p) excluded.push({ id, reason: "not_found" });
    else if (p.optedOut) excluded.push({ id, name: p.name, reason: "opted_out" });
    else if (p.allSequenceIds.includes(sequenceId)) excluded.push({ id, name: p.name, reason: "already_in_this_sequence" });
    else if (!opts.allowActiveElsewhere && p.activeSequenceIds.length > 0)
      excluded.push({ id, name: p.name, reason: "active_in_another_sequence" });
    else eligible.push(p);
  }

  const excludedByReason: Partial<Record<ExclusionReason, number>> = {};
  for (const e of excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;

  return { eligible, excluded, excludedByReason };
}

// ---------------------------------------------------------------------------
// Sequence state changes
// ---------------------------------------------------------------------------

export type StateAction = "pause" | "resume" | "finish";

/** Which current states each action applies to, and what the state becomes. */
const TRANSITIONS: Record<StateAction, { from: string[]; to: string }> = {
  pause: { from: ["active", "pending"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  finish: { from: ["active", "pending", "paused", "failed", "bounced", "opted_out", "disabled"], to: "finished" },
};

export function planStateChange(states: { id: number; state: string }[], action: StateAction) {
  const rule = TRANSITIONS[action];
  const sorted = [...states].sort((a, b) => a.id - b.id);

  return {
    change: sorted.filter((s) => rule.from.includes(s.state)),
    skip: sorted.filter((s) => !rule.from.includes(s.state)),
    expectedState: rule.to,
  };
}
