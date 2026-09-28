# Requester comment template

The last step for each request is a comment on the ticket asking the requester to review. It's written for someone who never saw the plan and doesn't need to: short, warm, and free of system jargon.

It does three things: **says what was built, links to it, and asks for a look before it goes live.**

---

## Example 1

Request: *"Set up nurture for trial signups who don't convert by day 7"*

> Hey, I've got the day-7 trial nurture built out and ready for you to look at. It's a three-email sequence that picks up anyone still on trial a week in, with a matching campaign on the Salesforce side so we can track it.
>
> Everything's parked and turned off for now, so nothing will go out until you give the word.
>
> Workflow: [link]
> Campaign: [link]
>
> Have a look when you get a chance and let me know if the timing or messaging needs a tweak.

## Example 2

Request: *"Need an Outreach sequence for the new job-change list"*

> Morning! The sequence for the job-change list is built and waiting on your review.
>
> It's four touches over two weeks, written for folks who've just landed somewhere new. Nobody's been added to it yet and it's switched off, so there's no risk of anything going out early.
>
> Sequence: [link]
>
> Give it a read and let me know if the angle feels right.

---

## What to avoid

> "Workflow enrolls contacts where `lifecycle_stage_example` = trial AND `custom_field_example` >= 7, syncing to the SFDC campaign via the standard integration mapping."

Accurate, unreadable, and aimed at the wrong audience.

## What the agent does NOT do

It posts the comment only. It doesn't change the ticket's status, reassign it, or mark it complete. Moving the ticket is the requester's call.
