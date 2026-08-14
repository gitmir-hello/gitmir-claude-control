---
name: spec-audit
description: >-
  Read the product's written rules — a specification, a client brief, an acceptance
  document, a set of tickets — against the code that is supposed to implement them, and
  record every place where they disagree as a finding attached to the objects it sits on.
  Use when someone asks whether the product does what it promised, before a demo or an
  acceptance meeting, after inheriting a codebase with a spec, or when a spec has been
  revised and nobody knows what the code still matches. Produces records that stay on the
  diagrams and warn anyone planning a change, not a report that scrolls out of a chat.
---

# Reading the rules against the code

A specification describes a product. The code is a second description of the same
product, written by different people at a different time. Wherever the two disagree,
somebody is going to be surprised — at a demo, at acceptance, or in production.

This procedure finds those places and **writes them down where they will be seen again**.
That last part is the whole point. A list of fifteen discrepancies in a conversation is
gone when the conversation ends: the agent that changes `pickCampaign` next week does not
know, and neither does the person who approves it. The same fifteen recorded as findings
sit on the objects they concern, mark them on every diagram, and warn anyone whose change
reaches them.

## Before you start

You need two things. If either is missing, say so and stop rather than guessing.

**The rules, written down somewhere.** A spec, `docs/`, an acceptance document, a client
brief, a decision log. Not "what the product obviously should do" — a claim you cannot
point at is not a finding, it is an opinion, and it will be argued away at exactly the
moment it matters.

**The model.** `.gitmir/model/` — built by the `gitmir-model` skill. Without it a finding
has nothing to attach to, and a finding that names no object shows up nowhere. Build the
model first.

## How to work

**Take the rules one section at a time, in the order they are written.** Not
file-by-file through the code — that finds what the code does and asks whether it was
required, which is backwards and misses everything the code does not do at all. The
largest category of finding is usually a rule nobody implemented, and it is invisible
from the code side.

For each rule, find the code that carries it. Use `model-navigate` — the model's own
links get you from "campaign priority" to the function that sorts campaigns without
reading the repository. Read the actual function. Then decide, out of four:

- **contradicts-spec** — it does something, and something else than the rule says
- **not-implemented** — the rule is not carried anywhere; the field exists and nothing reads it
- **undefined** — the code is non-deterministic where the rule assumed one answer
- **risk** — it matches the rule and will not survive production (unbounded reads, in-memory state, whole files in RAM)

**Record it immediately, with `gitmir_flag`.** Not at the end. A finding written when you
have the function open is precise; a finding written from memory at the end of a long pass
is vague, and a vague finding cannot be closed by anyone.

```
gitmir_flag(
  rule:        the rule in the product's own words, not a paraphrase
  actual:      what the code does instead, naming the function you read
  consequence: what goes wrong for a person — this is what makes it arguable
  source:      where the rule is written: "spec 5.2", "docs/pricing.md", a ticket id
  touches:     the model ids involved — this is what puts it on the diagrams
  readFrom:    the files you read it from — this is what makes it ask to be re-checked
  kind, severity
)
```

Both `touches` and `readFrom` matter more than they look. Without `touches` the finding is
in a list nobody opens. Without `readFrom` it cannot tell, later, that the code has moved
underneath it — and a confident claim about code that has since changed is worse than no
claim.

## What is a finding and what is not

**A finding needs all three:** a rule someone wrote down, what the code does instead, and
what that costs a person. Missing the first, it is a preference. Missing the third, nobody
will ever prioritise it.

**Not a finding:**

- Code you would have written differently. Style is not a deviation.
- A rule the spec never states, however obvious. Record it as `undefined` if the code is
  genuinely ambiguous — otherwise write it in the spec instead.
- Anything you have not read the code for. "Probably not implemented" recorded as a
  finding is a claim you have not checked, and it will be believed.
- Work already queued in `tasks/`. Check the queue first; a task that exists is a decision
  already made.

**Check what is already recorded** with `gitmir_findings` before writing. Re-flagging the
same rule updates the record rather than duplicating it — which is the right behaviour on
a second pass, and the reason to run this again after changes.

## After the pass

Report as a person would want to act on it:

1. **What is worst, and why** — the findings that break a rule the client can check
   themselves. These decide whether a demo happens.
2. **What is a decision, not a bug.** Some deviations are cheaper to accept than to fix.
   Say which, and say who has to decide — then use `gitmir_accept_finding` once they do,
   with their name and their reason. An accepted deviation with nobody attached is
   indistinguishable from one everybody forgot.
3. **What needs a written answer from whoever wrote the spec** — where the rule is
   ambiguous rather than the code being wrong.
4. **What you could not check**, and why: a section with no code you could find, a rule
   about behaviour nobody can observe from the repository. Absence recorded as absence is
   worth something; absence left silent reads as a clean bill of health.

Do not fix anything during the pass. A pass that also edits code stops being a
measurement — and the point of this one is that somebody can trust the number at the end.
If fixes are wanted, queue them with `task-planner` afterwards; each task will carry its
finding into the context automatically.

## Running it again

Findings go stale on purpose: each one remembers the files it was read from, and when one
of those changes the finding asks to be re-checked. That is a feature of the record, not
a defect — re-running this procedure over the stale ones is much cheaper than the first
pass, and it is what keeps the list from becoming a graveyard nobody believes.
