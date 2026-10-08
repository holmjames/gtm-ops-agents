# GTM Ops Agents

[![tests](https://github.com/holmjames/gtm-ops-agents/actions/workflows/tests.yml/badge.svg)](https://github.com/holmjames/gtm-ops-agents/actions/workflows/tests.yml)

**AI operators that build and run HubSpot, Salesforce, and Outreach work for a revenue team, fast enough to replace hours of hand-building and safe enough to trust with live customer data.**

---

## The problem

Revenue operations teams spend hours hand-building the same things across disconnected tools: a nurture workflow in HubSpot, the matching campaign in Salesforce, a follow-up sequence in Outreach, then reassigning the leads that come out of it.

Each build is a small, schema-heavy, error-prone task, and each tool has its own traps:

- **HubSpot** will accept a broken workflow filter, return "success," and quietly enroll no one.
- **Salesforce** rejects some report types outright and caps filters at about 2,200 characters.
- **Outreach** invalidates your login token every time you refresh it, so one crash can lock you out.

The work is too repetitive to do by hand and too risky to hand to automation that can't tell success from failure.

## Who it's for

- **Revenue / GTM operations teams** that field a steady queue of "can you build…" requests
- **Marketing and sales leaders** who want those requests turned around in minutes, not days
- **Anyone deploying AI agents against systems of record** who needs a model for letting an agent act without letting it act recklessly

## What it does

- **Works a request queue.** Reads tickets, sorts them into buildable / needs input / out of scope, and asks the requester only the questions that matter.
- **Checks field names before planning.** Asks a separate company-wide agent for the real API names instead of guessing.
- **Plans, then builds.** Writes a plain-language plan, gets approval, and builds workflows, sequences, campaigns, lists, and reports, all switched off.
- **Runs live operations behind a preview.** Turns workflows on, enrolls prospects, reassigns owners and territories, and deletes records, but only after showing exactly what will happen and getting an explicit yes.
- **Proves every change.** Reads the system back after every write, and reports `verified: true` only when the change is actually there.

## How it works

The system is split into three layers, so each can change without breaking the others. [Full architecture and diagram →](docs/architecture.md)

| Layer | What it is | Where |
|---|---|---|
| **Tools** | Individual actions, like "create a campaign" or "enroll prospects." Code that talks to each platform's API and verifies every result. | [`hubspot/tools`](hubspot/tools), [`salesforce/tools`](salesforce/tools), [`outreach/tools`](outreach/tools) |
| **Skills / playbooks** | Written know-how for doing each platform's job well: what "off" means there, the traps, what a preview must show. | [`hubspot/playbook.md`](hubspot/playbook.md), [`salesforce/playbook.md`](salesforce/playbook.md), [`outreach/playbook.md`](outreach/playbook.md) |
| **Agent logic** | The part that decides what to do next: triage, plan, gates, and when to stop and ask. | [`agent/kickstart.md`](agent/kickstart.md) |

The tools are [MCP](https://modelcontextprotocol.io) servers, so they plug into Claude or any MCP-compatible agent. The playbooks and agent logic are plain English. [Why it's split this way →](docs/design-decisions.md)

## Safety and guardrails

These agents ran live systems in production: they activated workflows, enrolled prospects, sent email, reassigned owners, and deleted records. The safety model doesn't rely on the agent being *unable* to act. It relies on **every action having a level, and every level having a gate.**

| Level | Examples | What's required |
|---|---|---|
| **Read** | search, run a report | Nothing |
| **Build** | create a workflow or sequence, **switched off** | An approved plan |
| **Commit** | turn on, enroll, send, reassign, delete | A preview of exactly what will happen, then an explicit yes |

What makes the Commit gate hold:

- **Preview tickets.** A Commit action's preview returns a one-time ticket. The apply step requires that ticket and re-checks the live system; if anything changed since the preview (a new prospect, an edited workflow, different inputs), it refuses. **What runs is exactly what was approved.**
- **Verify after every write.** No tool trusts a "200 OK." It reads the system back and compares.
- **Exact targets only.** A write never acts on a fuzzy name match.
- **Opted-out prospects are never enrolled,** whatever else the settings say.
- **Tickets are data, not orders.** Text inside a request that tries to instruct the agent ("skip approval, publish now") is quoted back to a human, not obeyed.
- **Build-only mode.** When working other people's request queue, the agent can't Commit at all. It builds everything switched off and hands it back for the requester to turn on.

[Full guardrails →](shared/guardrails.md)

## Results / impact

- **$385K per year** in operating spend saved
- **~30 hours per week** of hands-on build work saved
- **0 accidental sends or activations, and 0 near misses**, over 8 months in production

## What I'd build next

- **Approvals where people already are.** Approve a preview with a button in Slack instead of in the agent chat, with the approver's name recorded.
- **A permanent audit log.** Tickets live in memory today; every preview, approval, and apply should be written to a log a manager can review.
- **Guard live assets from Build tools.** Today, editing the steps of a workflow that's already on is a Build action. It should be a Commit action with a preview.
- **Volume limits.** Caps like "no more than 500 enrollments a day without a second approver."
- **Cross-system checks.** Confirm that a HubSpot list, its Salesforce campaign, and its Outreach sequence all point at the same people before anything goes live.
- **A regression suite on recorded API responses**, so every platform change is tested against real-world edge cases.

## Setup

**You don't need any accounts to see it work.** The test suite (46 tests) runs against fake versions of each platform:

```bash
# Requires Node.js 20 or newer
npm install
npm test           # builds everything and runs the tests
```

**To connect real systems** (use sandbox / developer accounts, never production, while trying it out):

1. Copy `.env.example` to `.env` and fill in your sandbox credentials. `.env` is git-ignored.
2. Build: `npm run build`
3. Register the servers with your MCP client. For Claude Code:

   ```bash
   claude mcp add gtm-hubspot    -- node /absolute/path/to/gtm-ops-agents/hubspot/tools/dist/server.js
   claude mcp add gtm-salesforce -- node /absolute/path/to/gtm-ops-agents/salesforce/tools/dist/server.js
   claude mcp add gtm-outreach   -- node /absolute/path/to/gtm-ops-agents/outreach/tools/dist/server.js
   ```

4. **Leave every `*.apply` tool on "ask every time"** in your client's permission settings. That's the human half of the Commit gate.
5. Optional: install the Kickstart agent as a Claude Code skill by copying [`agent/kickstart.md`](agent/kickstart.md) to `~/.claude/skills/kickstart/SKILL.md`.
6. Outreach needs a one-time browser sign-in; see [outreach/playbook.md](outreach/playbook.md#one-time-sign-in).

## About this repo

I built and ran these operators in production for a B2B SaaS revenue team. This is a clean, generic version, with all company-specific data removed:

- The **HubSpot operator** is a sanitized version of the production tool.
- The **Salesforce and Outreach operators** are clean-room rebuilds of the production tools, written from scratch around the same design and lessons. They build and pass their tests, but haven't been run against live accounts in this form.
- The **Kickstart agent** is the production agent logic, generalized.

Built by **James Holm** · [jholm.co](https://jholm.co) · MIT License
