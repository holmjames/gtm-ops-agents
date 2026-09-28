# Outreach playbook

> **What this file is.** A *skill*: written know-how for doing Outreach work well. The agent reads it before building. The actual API calls live in [tools/](./tools/).

In production this operator built sequences, enrolled prospects, and ran sends at volume. It was first brought in to diagnose why a sequence wasn't enrolling anyone, and it fixed the problem once the cause was found.

## What "off" means in Outreach

| Asset | Switched-off state | How to verify |
|---|---|---|
| Sequence | Inactive, **zero prospects** added | Read back the sequence: `enabled: false`, prospect count 0 |
| Email steps | Content written in place, but the sequence itself is never enabled | Read back the steps |

## Build rules

- **Look people up by email and check before touching them.** Every prospect lookup returns the owner and opt-out status. An opted-out prospect is never added to anything.
- **Outreach rotates its login token every time.** Each refresh issues a new token and the old one stops working. The tool saves each new token immediately. If it didn't, one crash could lock the server out until someone manually signed in again.
- **Sequence state changes use dedicated actions, not edits.** Outreach doesn't let you simply "edit" a sequence's state; each change has its own specific call. The tools wrap these so the agent can't get it wrong.
- **Never add anyone "just to test."** Test with a sequence that has zero prospects, or in a sandbox.

## Commit actions (need a preview and explicit approval)

Each of these is two tools: `<name>.preview` (changes nothing, returns a ticket) and `<name>.apply` (needs that ticket, and refuses if anything changed since the preview).

| Action | Tool | Preview shows |
|---|---|---|
| **Activate a sequence** | `sequences.activate` | Its steps and timing, and how many prospects already in it will start receiving email |
| **Add prospects to a sequence** | `sequences.enroll` | Who's enrolled, the sending mailbox, whether email starts immediately, and everyone **excluded** with the reason (opted out, already in this sequence, active in another) |
| Pause, resume, or finish prospects | `sequence_states.change` | Who changes, and who's skipped because their current state doesn't allow it |
| Delete prospects or sequences | `records.delete` | Exactly what's deleted, prospects still in a sequence, and a reminder that Outreach has no recycle bin |

**Turning a sequence OFF** (`sequences.deactivate`) needs no preview. It's the safe direction.

Enrolling prospects is the moment email actually starts going out, so this preview is the most important one in the whole system.

## One-time sign-in

Outreach only issues tokens through its browser sign-in (OAuth), so the first token has to come from a person:

1. Create an OAuth app in Outreach and put its client ID, secret, and redirect URI in `.env`.
2. Complete the sign-in once in your browser and exchange the returned code for tokens (see Outreach's API docs).
3. Save the result at the repo root as `.outreach-token.json`:

   ```json
   { "access_token": "…", "refresh_token": "…", "expires_at": 0 }
   ```

From then on the server refreshes and re-saves the token on its own. `.outreach-token.json` is in `.gitignore`, so it's never committed.
