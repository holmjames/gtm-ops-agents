# Design decisions

This is the product thinking behind the repo: why it's shaped this way, what I traded off, and what I chose not to build.

Where a decision depended on context only I have, it's marked **[YOUR INPUT: …]** instead of guessed.

---

## 1. Why split tools, skills, and agent logic

An agent like this could be written as one long instruction file: how to triage a ticket, how HubSpot names its fields, when to stop and ask, and which API calls to make, all mixed together. Splitting it into three layers gives each part a different **owner, rate of change, and failure mode**:

| Layer | Changes when… | Who can change it | If it's wrong… |
|---|---|---|---|
| **Tools** (code) | a platform's API changes | an engineer | the action fails loudly, and verification catches it |
| **Skills / playbooks** (plain English) | we learn a new trap or convention | anyone in ops | the agent builds something suboptimal, and a human catches it at a gate |
| **Agent logic** (plain English) | the workflow or team process changes | the ops lead | the agent does steps in the wrong order, and a gate catches it |

Three things this buys:

- **Non-engineers can improve the system.** The HubSpot trap where broken filters are silently accepted is handled by a paragraph in a playbook ("validate with a probe list first"), not a code change. Anyone in ops can add the next lesson the same way.
- **The tools are reusable.** The same Salesforce tools serve the request-queue agent, an ad-hoc chat session, or a future agent I haven't written yet. The agent logic is one *consumer* of the tools, not welded to them.
- **Safety lives in the right layer.** "Never enroll an opted-out prospect" is enforced in **code**, because it must never depend on the model remembering an instruction. "Ask the requester before choosing between two triggers" lives in **the agent**, because it's judgment.

**The rule of thumb I used:** if breaking the rule could send an email, it goes in code. If it's about doing the job *well*, it goes in a playbook. If it's about *what to do next*, it goes in the agent.

---

## 2. Why the guardrails exist, and why they look like this

### The starting point: "build everything off"

The request-queue agent (Kickstart) began with a simple rule: it can build, but everything is created switched off, and a human turns it on. For serving other people's tickets that's the right product choice. The requester owns the outcome, so the requester flips the switch.

### Why that wasn't enough

The operators themselves did far more than build. In daily use they activated workflows, enrolled prospects, sent email, reassigned account ownership, and deleted records. "It can't do anything live" wasn't true, and pretending otherwise would have made the tool useless for most of the real work.

So the question changed from *"how do we stop it acting?"* to *"how do we make acting safe?"*

### The answer: levels and gates

Every action got a level (**Read**, **Build**, **Commit**) and every level got a gate. The design choices inside that:

- **Preview must be concrete.** "This will update some records" isn't a preview. "40 accounts move: Rep A +10, Rep B +10, Rep C +10, Rep D +10" is. Each playbook specifies what its previews must show.
- **Approval must be specific.** Approving a plan doesn't approve turning it on. Approving one enrollment doesn't approve the next.
- **What runs must be what was approved.** This was the hardest part, and why preview tickets exist (below).
- **Switching off is always one step.** Turning a workflow or sequence *off* needs no preview. In an incident, the safe action should have the least friction.

### Preview tickets

An agent can say "I showed the human a preview and they approved" and still apply something different: new prospects matched between preview and apply, a teammate edited the workflow, or the agent changed an input. Instructions alone can't prevent that.

So each Commit preview records a **fingerprint** of what it saw and returns a one-time **ticket**. The apply step re-reads the live system, recomputes the fingerprint, and refuses unless it matches. Tickets are single-use and expire after 15 minutes.

**What this does not do, stated plainly:** the ticket proves the apply matches the preview. It cannot prove a human actually said yes. That half depends on the agent's instructions and on the MCP client's per-tool approval setting (leave `*.apply` on "ask every time"). I chose to name that gap rather than paper over it.

### Verify after every write

Every tool reads the system back after writing and reports `verified: true` only if the change is really there. This came directly from HubSpot, which will accept a malformed workflow filter, return success, and store it as "matches no one." A `200 OK` is a claim, not a fact.

(While building this repo I found two of my own tools that re-read the record but never actually compared the result. Both are fixed and now have tests. The principle is only as good as its enforcement.)

These guardrails weren't a reaction to an incident. Over eight months of production use there were **zero accidental sends or activations, and zero near misses.** That's the outcome the design is for: when the gates work, nothing dramatic happens.

---

## 3. Tradeoffs I made

| Decision | What I gained | What I gave up |
|---|---|---|
| **Humans approve every Commit** | No surprise sends, no silent reassignments | Speed. A Commit waits for a person. **[YOUR INPUT: typical wait for an approval]** |
| **Build-only mode for the request queue** | Requesters own their launches, and the agent can't be talked into going live by a ticket | An extra hand-off step for every request |
| **Ask the field-reference agent before planning** | Far fewer wrong-field builds | One more round trip per request |
| **Report builds copy a template instead of building from scratch** | Reliability. Salesforce's report API fails loudly and unpredictably on from-scratch builds | Flexibility. You need a good template to start from |
| **Exact-name targeting only** | The agent can never mutate the wrong workflow by fuzzy match | Occasional friction when a name has a typo |
| **Tickets held in memory** | Simple, and no database to run | A server restart invalidates pending approvals, and there's no permanent approval log (see "What I'd build next") |
| **Enrollment excludes prospects active in another sequence by default** | Protects prospects from double-sequencing | Sometimes a legitimate enrollment needs an explicit override |

---

## 4. What I deliberately chose not to build

- **No autonomous mode.** There is no setting that lets the agent Commit without a human. Even for "safe" high-volume operations, the cost of one wrong send outweighs the time saved.
- **No "create report from scratch."** Given how Salesforce's reporting API behaves, a template-copy tool that works every time beat a flexible tool that works sometimes.
- **No Salesforce Enterprise Territory Management.** Territory assignment is rule-based (for example, "BillingState in CA, OR, WA → West → this owner"), because that covered the real need and a full territory-model integration didn't. **[YOUR INPUT: confirm this matches how territories were actually managed]**
- **No raw "send this email" tool in this version.** Here, email goes out only through workflows and sequences, which carry their own review, scheduling, and unsubscribe handling. **[YOUR INPUT: the production HubSpot operator did send email. Say how it did (for example, marketing-email sends) and whether you'd add that back behind a Commit preview]**
- **No deletion in build-only mode.** The request-queue agent can't delete anything. Deletion exists only as a Commit action, with a preview, for a human operator.
- **No UI.** The interface is the conversation with the agent. **[YOUR INPUT: was a UI considered and rejected, or just never needed?]**

---

## 5. The agent that checks with another agent

Before planning, the request-queue agent asks a separate, company-wide Claude agent (one with read access to the data warehouse and CRM schemas) to confirm field names and valid values. It asks about every field in one message, uses exactly what comes back, and treats any disagreement between that agent and the live system as an open question for a human.

That was a deliberate choice about **where knowledge lives**: the field-reference agent is the company's source of truth for schema questions, so the ops agent defers to it instead of keeping its own copy that would drift.

**[YOUR INPUT: anything worth adding about how the two agents worked together, e.g. how often it caught a wrong field]**

---

## 6. How I'd measure success

- **Operating spend:** $385K per year saved
- **Time:** ~30 hours per week of hands-on build work saved
- **Safety:** 0 accidental activations or sends, 0 near misses in 8 months
- **Error rate:** builds that needed rework after review **[YOUR INPUT]**
- **Adoption:** requests handled per week, and how many teams sent requests **[YOUR INPUT]**
