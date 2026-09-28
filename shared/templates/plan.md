# Plan template (Gate 1)

The agent writes one of these for each request and then **stops**. Nothing gets built until a human approves it.

One plan per request. Batching several requests into one plan makes it unclear what was actually approved.

---

```markdown
## Plan: [request name]
[link to the request ticket]

**What the request is asking for**
One or two sentences, in plain language.

**What gets built**
- System: HubSpot | Salesforce | Outreach
- Asset: the specific thing, and the name it will be given
- Trigger / enrollment / entry criteria
- Steps or actions inside it
- Where it hands off, if anywhere

**Fields this depends on** (confirmed with the field-reference agent)
- custom_field_example - what it holds - which system

**Level of each action**
- Build: [what gets created, switched off]
- Commit: [anything that would go live; each item gets its own preview and approval later]

**What it will NOT do**
The safety statement: what stays off, who is not enrolled, what is not sent.

**Open questions**
Anything genuinely unresolved. Write "none" if there are none; don't invent questions.
```

---

End with a direct request for approval, then stop. A reply that only addresses part of the plan isn't full approval, so confirm the rest before building.
