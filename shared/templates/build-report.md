# Build report template (Gate 2)

After building, the agent reports what now exists. Each item is linked, and each item's state has been **read back from the system**, not assumed.

---

```
Built and staged for [request name]:

- HubSpot workflow "ACME Trial Nurture - Day 7" - UNPUBLISHED, 0 enrolled
  [link]
- Salesforce campaign "ACME Trial Nurture" - status Planned
  [link]
- Outreach sequence "ACME Trial Nurture - Day 7 Touch" - INACTIVE, 0 prospects
  [link]

Nothing is live. Ready for review.
```

---

If anything differs from the approved plan, the report says so explicitly and explains why.

If the next step is a **Commit** (turning something on, enrolling, sending), the report ends with the preview for that action. See [guardrails.md](../guardrails.md#what-a-commit-preview-must-show).
