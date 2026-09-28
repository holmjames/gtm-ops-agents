# Architecture

## The big picture

```mermaid
flowchart TB
    human(["👤 Ops lead / requester"])
    queue[("Request queue<br/>(Asana)")]
    fieldref["Field-reference agent<br/>(company-wide Claude agent<br/>with warehouse access)"]

    subgraph agent["AGENT LOGIC · agent/kickstart.md"]
        direction LR
        triage[Triage] --> plan[Plan] --> gate1{{"Gate 1<br/>approve plan"}} --> build[Build, switched off] --> gate2{{"Gate 2<br/>approve result"}}
    end

    subgraph skills["SKILLS / PLAYBOOKS"]
        guard[shared/guardrails.md]
        pbs["hubspot · salesforce · outreach<br/>playbook.md"]
        tmpl[shared/templates]
    end

    subgraph tools["TOOLS · MCP servers"]
        hs["HubSpot operator<br/>31 tools"]
        sf["Salesforce operator<br/>13 tools"]
        otr["Outreach operator<br/>12 tools"]
        shared["shared/tools<br/>envelope · commit gate"]
    end

    hubspot[(HubSpot)]
    salesforce[(Salesforce)]
    outreach[(Outreach)]

    queue --> triage
    plan -. "asks for real field names" .-> fieldref
    gate1 <--> human
    gate2 <--> human
    agent -- reads --> skills
    agent -- calls --> tools
    hs --> hubspot
    sf --> salesforce
    otr --> outreach
    hs & sf & otr --- shared
```

**Reading it top to bottom:**

1. **Agent logic** decides *what to do next*. It's plain English (a Claude skill), not code.
2. **Skills / playbooks** hold *how to do it well*: the rules for each platform, and the templates for plans and reports. Also plain English.
3. **Tools** *do the actual work*: small, strict programs that call each platform's API. Every one answers in the same format and checks its own work.

## The three safety levels

Every tool falls into one level. The level decides what has to happen before it runs.

```mermaid
flowchart LR
    R["READ<br/>search, run a report"] -->|always allowed| ok1((run))
    B["BUILD<br/>create, switched off"] -->|approved plan| ok2((run))
    C["COMMIT<br/>turn on, enroll, send,<br/>reassign, delete"] -->|preview → explicit yes → ticket| ok3((run))
```

## How a Commit action runs

Every Commit action is published as **two tools**: `<name>.preview` and `<name>.apply`.

```mermaid
sequenceDiagram
    actor Human
    participant Agent
    participant Tool as Commit tool
    participant Gate as Commit gate
    participant API as Platform API

    Agent->>Tool: owners.round_robin.preview(40 accounts, 4 reps)
    Tool->>API: read accounts + current owners
    Tool->>Gate: fingerprint of what it saw
    Gate-->>Tool: ticket ct_9f2c…
    Tool-->>Agent: "40 accounts move: Rep A +10, Rep B +10…" + ticket
    Agent->>Human: shows the preview
    Human->>Agent: "Approved"
    Agent->>Tool: owners.round_robin.apply(same inputs, ticket)
    Tool->>API: read accounts + owners AGAIN
    Tool->>Gate: does the new fingerprint match the ticket?
    alt something changed since the preview
        Gate-->>Tool: refused: changed_since_preview
        Tool-->>Agent: nothing applied, here's the new preview
    else unchanged
        Gate-->>Tool: ok (ticket now used up)
        Tool->>API: update owners
        Tool->>API: read owners back
        Tool-->>Agent: verified: true
    end
```

The **fingerprint** is a hash of everything that matters for that action: which records, their current owners, a workflow's revision number, the inputs themselves. If any of it changes between preview and apply, the hashes differ and nothing happens.

## The response every tool gives

All 56 tools answer in the same shape, so one agent can drive three platforms without learning three ways of reporting success:

```jsonc
{
  "ok": true,
  "operation": "campaigns.create",
  "data": { "campaign": { "Id": "701…", "Name": "ACME Webinar - Q4", "IsActive": false } },
  "audit": {
    "attempted": true,   // did it try to change something?
    "verified": true,    // did it read the system back and confirm the change?
    "targetType": "campaign",
    "targetId": "701…"
  }
}
```

## Repo map

```
gtm-ops-agents/
  agent/kickstart.md          Agent logic: the request-queue loop and its gates
  shared/
    guardrails.md             The three levels and the rules that always apply
    templates/                Plan, build report, requester comment
    tools/src/
      commitGate.ts           Preview tickets: issue, check, expire
      commitTools.ts          Turns a Commit action into .preview + .apply tools
      envelope.ts             The shared response shape
  hubspot/     playbook.md + tools/ (workflows, lists, CRM records)
  salesforce/  playbook.md + tools/ (reports, campaigns, owners, territories)
  outreach/    playbook.md + tools/ (prospects, sequences, enrollment, token rotation)
  examples/walkthrough.md     One request, start to finish
  docs/                       This file, and the design decisions
```

## Tech

TypeScript (strict) · [Model Context Protocol](https://modelcontextprotocol.io) SDK · `zod` input schemas · Node's built-in test runner · `dotenv` · HubSpot REST v3/v4 · Salesforce REST + Analytics API · Outreach API v2 (JSON:API).
