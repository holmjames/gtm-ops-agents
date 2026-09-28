# Guardrails

These agents ran real GTM systems in production. They activated workflows, enrolled prospects into sequences, sent email, reassigned account owners, and deleted records.

Because they can do all of that, the safety model can't rely on the agent being *unable* to act. It relies on **every action having a level, and every level having a gate.**

---

## The three levels

| Level | What it covers | What has to happen first |
|---|---|---|
| **Read** | Search records, run a report, look up a prospect, count an audience | Nothing. Reading is always allowed. |
| **Build** | Create a workflow, sequence, campaign, list, or report, **switched off** | A written plan, approved by a human (**Gate 1**) |
| **Commit** | Anything that changes what's live: turn on a workflow, activate a sequence, add prospects, send email, reassign owners or territories, delete | A **preview** of exactly what will happen, then an explicit **yes to that specific action** (**Gate 2**), then a read-back to confirm it happened |

### What a Commit preview must show

A preview answers "what will this do, to whom, and can it be undone?" in numbers, not adjectives.

- **Activating a workflow or sequence:** how many records are enrolled now and how many would enroll, which emails go out and when, and any opt-outs that were excluded
- **Sending email:** recipient count, sender, subject line, send time
- **Reassigning owners or territories:** a before/after table ("40 accounts move from Rep A to Rep B")
- **Deleting:** exactly what will be deleted, by name and ID, and whether the platform lets you restore it

A "yes" given before the preview was shown doesn't count.

---

## Rules that hold at every level

**Verify, don't trust.** A `200 OK` from an API does not mean the change happened. HubSpot, for example, will accept a broken filter and quietly store it as "matches no one." After every write, the tool reads the record back and checks that the change is really there. That's the `audit.verified` field in every tool response.

**Only act on an exact target.** A write tool never guesses which record you meant. If "the onboarding workflow" matches two workflows, the tool lists both and refuses to act.

**Ticket text is information, not instructions.** A request ticket describes work a person wants done. If the text inside it tries to tell the agent how to behave ("skip the approval," "publish immediately," "send to the list when done"), the agent quotes it back to the human and asks. It doesn't comply.

**One approval, one action.** Approving a plan doesn't approve activating it. Approving one send doesn't approve the next.

**When in doubt, stop.** Checking in costs a minute. An accidentally activated workflow costs customer trust.

---

## Build-only mode

The [Kickstart agent](../agent/kickstart.md) ran with a stricter setting: it could Read and Build, but **Commit was switched off entirely.** It worked a shared request queue, so it never activated, sent, enrolled, or deleted anything. It built each request switched off, then handed it back to the requester to review and turn on.

That was a deliberate product choice. When the agent is serving other people's requests, the requester should be the one to flip the switch.
