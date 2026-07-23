Distill messy input into a small, high-signal brief the AI (and the people) can
act on — written to this project's `.gitmir/brief.json`. The whole point of GitMir
is to assemble a *small* context for a model instead of feeding it everything;
this skill produces that context. It is the intent layer that complements
`.gitmir/model/` (which the `gitmir-model` skill builds): the **model** says what
the software IS, the **brief** says what it must DO and why.

Use it when the input is a pile rather than a spec: product docs, a README, a
ticket, a pasted email or chat thread, a rambling goal in someone's words, or the
existing code itself. Especially useful when whoever wants the work cannot
formulate a clean task — you turn "here is what we'd like and what hurts" into a
structured brief both sides can read and confirm BEFORE anything is built.

## What to read

Read the sources the user points at (docs, tickets, threads, the goal in their
own words) and, if it exists, `.gitmir/model/` — so the brief is grounded in what
the product actually is, not a guess. Read once; do not spiral into the whole repo.

## What to write — `.gitmir/brief.json`

Pretty-printed JSON, 2-space indent, exactly this shape:

    {
      "summary": "one or two plain sentences: what this is and the outcome wanted",
      "must": [
        { "text": "a requirement that must hold",
          "criteria": [
            { "text": "a concrete, checkable acceptance test", "kind": "build" }
          ] }
      ],
      "nice": ["wanted but not required"],
      "out": ["explicitly NOT in scope this round"],
      "decisions": [
        { "conflict": "the tension in the input",
          "decision": "what we chose",
          "rationale": "why" }
      ],
      "openQuestions": ["a real gap — not guessed, needs a human answer"]
    }

`criteria[].kind` is one of: `build` (compiles / typechecks / lints),
`smoke` (the thing runs without erroring), `flow` (a user path works end to end),
`manual` (a person has to eyeball it). Every `must` should carry at least one
criterion — a requirement you cannot check is a wish.

## How to distill

1. **Find the real goal.** Strip pleasantries and restated problems down to the
   outcome someone actually wants. Put it in `summary`.
2. **Separate must from nice from out.** What has to be true for this to count as
   done goes in `must`. What would be pleasant goes in `nice`. What people might
   assume but you are deliberately NOT doing goes in `out` — scope you name is
   scope that stops surprise rework.
3. **Turn each must into checkable criteria.** Not "make it fast" but "list
   endpoint returns in under 300ms on 1k rows" (`flow`). Vague criteria are the
   main way "done" gets faked.
4. **Surface conflicts and resolve them.** When the input contradicts itself (two
   people wanted different things, or a doc fights the code), record it in
   `decisions` with the choice and the reason — do not silently pick one.
5. **List honest open questions.** Where the input genuinely does not say, write
   the question in `openQuestions`. Never invent an answer to make the brief look
   complete — a fabricated requirement is worse than a flagged gap.
6. **Keep it small.** The brief is a page, not the source material re-typed. If it
   is long, you are copying, not distilling.

## Re-running (idempotent)

If `.gitmir/brief.json` already exists, load it and update in place: keep settled
`decisions`, fold in new input, move an `openQuestion` into a `must`/`decision`
once it is answered. Do not wipe prior decisions to start clean.

## Rules

- Write **only** `.gitmir/brief.json`. Do not touch application source, and do not
  overwrite `.gitmir/model/` (that is the `gitmir-model` skill's).
- Ground every line in the input or the model — never invent requirements.
- A brief the requester can read and say "yes, that is what we meant" (or "no,
  wrong") is the goal. Optimise for that confirmation, not for looking thorough.
- Hand off: `task-planner` turns this brief plus the model into runnable tasks.
