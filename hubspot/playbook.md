# HubSpot playbook

> **What this file is.** A *skill*: written know-how for doing HubSpot work well. The agent reads it before building. The actual API calls live in [tools/](./tools/).

## What "off" means in HubSpot

| Asset | Switched-off state | How to verify |
|---|---|---|
| Workflow | Unpublished (`isEnabled: false`), "enroll existing records" off | `workflows.get` shows `isEnabled: false`; enrollment count is 0 |
| List | Can be created, but **not attached** as a live workflow's enrollment trigger | `lists.get` |
| Marketing email | Draft, never scheduled | Read back its state |

## Build rules

- **Create workflows as empty, disabled shells first** (`workflows.create_manual`), then add enrollment criteria, steps, and goals one at a time. Each step verifies itself, so a failure points to exactly one change.
- **Validate filters with a throwaway list before using them in a workflow.** HubSpot will accept a broken enrollment filter, return `200 OK`, and quietly treat it as "matches no one." A *list* with the same filter returns real per-filter errors and a real member count. So: create a probe list → check the count looks sane → apply the filter to the workflow → delete the probe list.
- **Edits are all-or-nothing.** HubSpot's workflow API needs the *whole* workflow sent back to change one field. The tools handle this (`sanitizeWorkflowForUpdate`), so always go through them and never hand-edit the payload.
- **Target by exact ID or exact name only.** If a name matches more than one workflow, the tool refuses and lists the candidates.
- **Cross-workflow "go to workflow" steps aren't always possible through the API.** When the tool returns `unsupported_via_api: true`, that's a portal limit, not a mistake. Tell the human it needs a manual step.

## Commit actions (need a preview and explicit approval)

Each of these is two tools: `<name>.preview` (changes nothing, returns a ticket) and `<name>.apply` (needs that ticket, and refuses if anything changed since the preview).

| Action | Tool | Preview shows |
|---|---|---|
| Turn a workflow on | `workflows.enable` | Enrollment criteria, re-enrollment setting, goal, steps by type, a reviewer checklist |
| Delete a workflow | `workflows.delete` | Name, ID, whether it's live, its steps |
| Delete a list | `lists.delete` | Name, ID, member count |
| Add or remove list members | `lists.members.add` / `.remove` | Who changes, who's skipped and why |
| Update record properties | `crm.update_properties` | Before → after, for each field |

**Turning a workflow OFF** (`workflows.disable`) needs no preview. It's the safe direction, and in an emergency it should take one step.
