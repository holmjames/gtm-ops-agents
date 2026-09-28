# Walkthrough: one request, start to finish

An illustrative example with made-up data (ACME Corp). It shows what each step looks like from the ops lead's side of the conversation.

---

## The request

A ticket lands in the queue from the demand-gen manager:

> **Webinar follow-up for the Q4 product webinar**
> Can we get a follow-up going for everyone who registered? Attendees and no-shows should get different emails. We'll also need the SDR team to split the attendee accounts for call follow-up.

---

## 1. Triage

```
Queue: 4 open tickets

Buildable (2)
  - Webinar follow-up for the Q4 product webinar - due Thu - HubSpot workflow + Outreach sequence + SF campaign
  - Clean up duplicate "Trial" lists - no due date - list review

Needs input (1)
  - Partner newsletter - which audience: all partners, or active partners only?

Out of scope (1)
  - "Turn off the old onboarding workflow" - modifies a live asset; needs the owner's sign-off
```

## 2. Confirm fields

The agent asks the field-reference agent in one message:

> Working a ticket that needs a HubSpot workflow branching on webinar attendance and a Salesforce campaign for the Q4 webinar. Can you confirm the API names and valid values for: webinar attendance status on the HubSpot contact, and the Salesforce campaign member statuses we use for webinars?

The reply: `webinar_attendance_example` (values `attended`, `registered_no_show`), and campaign statuses `Registered`, `Attended`, `No Show`.

## 3. The plan (Gate 1)

```markdown
## Plan: Webinar follow-up for the Q4 product webinar

**What the request is asking for**
Different follow-up for attendees vs. no-shows, plus a campaign to track it, plus
an SDR split of attendee accounts.

**What gets built**
- HubSpot workflow "ACME Q4 Webinar - Follow-up": enrolls registrants, branches on
  webinar_attendance_example, 2 emails per branch
- Salesforce campaign "ACME Q4 Webinar" (Planned, inactive)
- Outreach sequence "ACME Q4 Webinar - Attendee Calls": 3 steps (call, email, call)

**Fields this depends on** (confirmed with the field-reference agent)
- webinar_attendance_example - attended / registered_no_show - HubSpot contact
- CampaignMember.Status - Registered / Attended / No Show - Salesforce

**Level of each action**
- Build: the workflow, the campaign, and the sequence, all switched off
- Commit: none in this mode. Turning things on, adding campaign members, the SDR
  split, and enrollment are done afterward by an operator, each with its own preview

**What it will NOT do**
Nothing is turned on, nobody is enrolled, nothing is sent in this step.

**Open questions**
None.
```

> **Ops lead:** Approved.

## 4. Build report (Gate 2)

```
Built and staged for "Webinar follow-up for the Q4 product webinar":

- HubSpot workflow "ACME Q4 Webinar - Follow-up" - UNPUBLISHED, 0 enrolled   verified
- Salesforce campaign "ACME Q4 Webinar" - status Planned, inactive           verified
- Outreach sequence "ACME Q4 Webinar - Attendee Calls" - OFF, 0 prospects,
  3 steps                                                                    verified

Nothing is live. Ready for review.
```

## 5. Comment on the ticket

> Hey! The webinar follow-up is built and ready for you to look at. Attendees and no-shows each get their own two-email track, the campaign is set up in Salesforce so we can see who engaged.
>
> The emails and the call sequence are parked and turned off, so nothing goes out until you give the word.
>
> Workflow: [link]
> Campaign: [link]
> Call sequence: [link]
>
> Have a look when you get a chance and let me know if the timing or messaging needs a tweak.

---

## 6. Later: a Commit, outside the queue

The request-queue agent runs in **build-only mode**, so it can't reassign anyone. Once the requester signs off, the ops lead works with the operators directly to do the SDR split. The agent calls `owners.round_robin.preview`:

```jsonc
{
  "ok": true,
  "operation": "owners.round_robin.preview",
  "data": {
    "summary": "Reassign 38 Account record(s) across 4 rep(s).",
    "preview": {
      "byRep": [
        { "rep": "Avery Chen",   "assigned": 10, "gained": 10, "lost": 0 },
        { "rep": "Sam Patel",    "assigned": 10, "gained": 9,  "lost": 0 },
        { "rep": "Jordan Lee",   "assigned": 10, "gained": 10, "lost": 0 },
        { "rep": "Riley Brooks", "assigned": 10, "gained": 9,  "lost": 0 }
      ],
      "moves": [
        { "record": "ACME Industrial", "from": "Integration User", "to": "Avery Chen" },
        { "record": "ACME Logistics",  "from": "Integration User", "to": "Sam Patel" }
        // … 36 more
      ],
      "movesTotal": 38,
      "alreadyWithAssignedRep": 2,
      "notFound": [],
      "nextStartIndex": 0
    },
    "ticket": "ct_9f2c41a07b3e",
    "expiresAt": "2026-10-02T17:15:00.000Z",
    "nextStep": "Nothing has changed yet. Show this preview to a human. Only if they explicitly approve it, call owners.round_robin.apply with the same inputs and this ticket."
  },
  "audit": { "attempted": false, "verified": false, "targetType": "Account" }
}
```

> **Agent:** 38 of the 40 attendee accounts would move; 2 already belong to the rep they'd be assigned. Each SDR ends up with 10. Approve?
>
> **Ops lead:** Approved.

The agent calls `owners.round_robin.apply` with the same inputs and the ticket. The tool re-reads all 40 accounts, confirms nothing changed since the preview, updates the owners, and reads them back:

```jsonc
{
  "ok": true,
  "operation": "owners.round_robin.apply",
  "data": { "updated": 38 },
  "audit": { "attempted": true, "verified": true, "targetType": "Account" }
}
```

**If a teammate had reassigned one of those accounts in between,** the apply would have returned `changed_since_preview`, changed nothing, and shown the new preview for a fresh approval.
