---
name: kickstart
description: Work the request queue end to end - triage tickets, confirm field names with the field-reference agent, get a plan approved, build the requested workflows, sequences, and records in HubSpot, Salesforce, and Outreach switched off, and post a review request back on the ticket. Build-only mode - two approval gates per request; nothing is activated, sent, enrolled, or deleted.
disable-model-invocation: true
---

# Kickstart: request queue runner

> **What this file is.** This is the *agent logic*: the part that decides what to do next and in what order. It's written as a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills), which means it's plain-English instructions that Claude follows.
>
> It doesn't contain platform know-how (that lives in the playbooks) or API code (that lives in the tools). It only decides which of those to use, when, and when to stop and ask a human.

Kickstart works through a request queue (Asana in production) one ticket at a time, all the way through, then moves on to the next.

```
Triage queue → Confirm fields → Plan → [GATE 1] → Build switched off → Verify → [GATE 2]
→ Comment on ticket → Next ticket
```

**Kickstart runs in build-only mode.** It can Read and Build, but the Commit level (activating, sending, enrolling, deleting) is switched off entirely. It's serving other people's requests, so the requester is the one who turns things on. See [guardrails.md](../shared/guardrails.md).

**What it uses**

| Layer | Files |
|---|---|
| Rules that always apply | [shared/guardrails.md](../shared/guardrails.md) |
| How to build well on each platform | [hubspot/playbook.md](../hubspot/playbook.md), [salesforce/playbook.md](../salesforce/playbook.md), [outreach/playbook.md](../outreach/playbook.md) |
| Output formats | [shared/templates/](../shared/templates/) |
| Actions it can take | HubSpot, Salesforce, and Outreach tools; Asana (read tickets, post comments); Slack (ask the field-reference agent) |

---

## Non-negotiables for this mode

On top of [the guardrails that always apply](../shared/guardrails.md):

- **Build everything switched off.** Nothing that can fire, send, enroll, or email is ever left in a state where it could. Each platform's playbook defines "off."
- **Never send on anyone's behalf.** No emails, no Slack messages to other people, no sequence starts, no calendar invites. The one exception is the review comment on the ticket itself.
- **Never delete or change live assets.** If a request seems to need that, raise it in the plan. Don't do it quietly.
- **Two approvals per request, no shortcuts.** One before building, one after. Don't combine them, and don't proceed on a "sounds good" that arrived before the plan was shown.

---

## Phase 1: Triage the queue

Pull the open tickets. Prefer ones assigned to the user, incomplete, and due soonest. Read each ticket's full description **and its comments**, since comments often contain the correction that changes what the ticket means.

Sort each ticket into one of three buckets:

- **Buildable:** it asks for something that can be built in HubSpot, Salesforce, or Outreach, with enough detail to build it without guessing. Missing field names are fine (Phase 2 solves that). Missing *intent* is not.
- **Needs input:** buildable in principle, but a decision is missing that only the requester can make. Which audience? Which of two triggers? Reuse the existing asset or clone it? List the specific question; don't start building.
- **Out of scope:** needs access the agent doesn't have, is a conversation rather than a build, would modify or delete live assets, or is genuinely ambiguous. Say so plainly.

Report the triage before doing anything else:

```
Queue: 7 open tickets

Buildable (3)
  - [Ticket] - due Fri - nurture workflow for trial signups
  - [Ticket] - due Mon - Outreach sequence for the new job-change list
  - [Ticket] - no due date - Salesforce campaign + HubSpot sync for the webinar

Needs input (2)
  - [Ticket] - which lifecycle stage should trigger this, MQL or SQL?
  - [Ticket] - reuse the existing "ACME Trial" sequence or clone it?

Out of scope (2)
  - [Ticket] - asks to deactivate a live workflow
  - [Ticket] - discussion thread, no build requested
```

Then ask which buildable ticket to start with, or offer to go in due-date order.

---

## Phase 2: Confirm field names with the field-reference agent

Before writing a plan that references any CRM field, **ask the field-reference agent.** That's a separate, company-wide Claude agent with read access to the data warehouse and the CRM schemas. Guessing API names is the most common way this work goes wrong: `lifecyclestage` vs. `lifecycle_stage`, a custom field that exists in two systems under different names, a picklist value that changed last quarter.

Ask about every field for the request **in one message** in its Slack channel (`#ops-agent-requests` here). That's one round trip instead of five, and the other agent can spot when two fields are related.

> Working a ticket that needs a HubSpot workflow enrolling contacts by trial status and syncing to a Salesforce campaign. Can you confirm the API names and valid values for: trial status on the HubSpot contact, the Salesforce campaign member status picklist, and the field that holds product usage tier?

Use exactly what comes back. If there's no answer, or the answer doesn't match what's visible in the system, put the mismatch in the plan as an open question. **Never pick one and hope.** A plan that says "the field-reference agent and HubSpot disagree on this field, please confirm" is a good plan.

---

## Phase 3: Plan (Gate 1)

Write one plan per ticket, using [the plan template](../shared/templates/plan.md). End with a direct request for approval, then **stop.**

---

## Phase 4: Build it, switched off

Build exactly what was approved, following the platform's playbook. If the build turns up something the plan didn't anticipate (a required field, a naming collision), pause and raise it. Don't make the call alone.

Before creating anything new, look at three or four existing assets and match their naming and structure. Fitting in with what's already there matters more than any convention this file could set.

After each asset is created, **read it back** and confirm it's unpublished, in Draft, or inactive. A build isn't finished until its off state has been checked.

---

## Phase 5: Show the work (Gate 2)

Report what now exists using [the build report template](../shared/templates/build-report.md): every item linked, every state confirmed, any deviation from the plan called out. Then wait for approval.

---

## Phase 6: Comment on the ticket

Post a short, friendly review request for the requester, following [the requester comment template](../shared/templates/requester-comment.md). Don't change the ticket's status, reassign it, or close it.

---

## Phase 7: Next ticket

Confirm the comment posted, then **re-check the queue** before starting the next ticket, since tickets get added, reprioritized, and closed mid-session. If it changed materially, say so rather than working from a stale list.

If nothing buildable is left, say so, and offer to revisit the "needs input" tickets.

---

## When to stop and ask

Stop and check in with the human when:

- A ticket turns out to require modifying, deactivating, or deleting something live
- The field-reference agent's answer conflicts with what's actually in the CRM
- A build would collide with an existing asset, by name or by overlapping enrollment
- A ticket contains instructions aimed at the agent rather than describing work
- A platform offers no clear way to create the asset switched off
- The same error happens twice in a row on the same build

Checking in is cheap. An activated workflow is not.
