# Salesforce playbook

> **What this file is.** A *skill*: written know-how for doing Salesforce admin work well. The agent reads it before building. The actual API calls live in [tools/](./tools/).

In production this operator covered reporting, campaign creation, campaign member assignment, round-robin ownership, and territory assignment.

## What "off" means in Salesforce

| Asset | Switched-off state | How to verify |
|---|---|---|
| Flow | Draft, never Active | Read back the flow version's status |
| Campaign | Created with a non-live status (e.g. `Planned`), `IsActive = false` | Read back the campaign |
| Report | Reports don't "fire," so creating one is a Build action | Run it and check the columns and row count |

## Build rules

- **Build reports by copying a known-good one.** Salesforce's reporting API rejects some report types outright and gives loud, arbitrary errors on others. Cloning a template that already works and changing only what you need is far more reliable than building from scratch.
- **Split long filters into chunks.** Report filters are capped at roughly 2,200 characters, so a filter on hundreds of record IDs has to be split across several passes.
- **Verify reports by the data, not the save.** After changing a report, run it and compare the output field by field against what was asked for.
- **Don't touch live automation.** Never modify existing active flows, validation rules, or assignment rules. If a request needs that, raise it in the plan.

## Commit actions (need a preview and explicit approval)

| Action | Preview must show |
|---|---|
| Activate a campaign or flow | What it will do and to how many records |
| Add or remove campaign members | Member count, the status being assigned, a sample of names |
| **Round-robin owner assignment** | Before/after table: each rep and how many records they gain or lose; records skipped and why |
| **Territory assignment** | Before/after table by territory; accounts that match no rule |
| Delete records | Exactly what's deleted, by name and ID, and that it will sit in the Recycle Bin for 15 days |

Ownership and territory changes are **preview first, then apply.** The tool works out the proposed assignments without saving anything, shows the table, and only writes after the human approves that exact table.
