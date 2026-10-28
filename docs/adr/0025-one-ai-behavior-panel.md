# ADR 0025: One AI behavior panel

Status: partly superseded: choices autosave through scoped settings writes; pickiness lives on Find jobs and application writing under Applying rather than one AI-behavior draft and Save (142ef55e). Pickiness is a display fit floor, not strict collection or plan breadth (ADR 0041, a1cdeb6b). Saved behavior and writing permissions remain accepted.

## Context

Every choice about how the AI behaved lived beside the surface it affected, in a different shape each time. The resume tailoring strength was a dropdown on Profile, Preferences; the original-versus-tailored default was a pair of cards in Settings that also held the template and font; the strict collection filter was a checkbox at the bottom of Preferences; search breadth was a per-run toggle on the Find jobs bar that reset on every visit; cover-letter tone and length were a Settings card with no place in the section nav; the Profile chat's manner and the apply agent's writing were not the person's to choose at all. A person who wanted the app to be more or less aggressive had to know which page held which knob.

Two decisions from the same testers pull the other way. ADR 0023 says the model owns the run and code adds only safety; ADR 0012 and ADR 0022 say sending, sign-in, and account creation are the person's. Neither says the person may not tell the model how it should behave.

## Decision

- Settings gets one section, **AI behavior**, that holds every choice about how the AI works, grouped by the person's own flow: Profile assistant (how much it volunteers, how long it talks), Finding jobs (how picky, whether remote counts as any location), Applying (when to write a letter, how long written answers run, and how a letter should read). One draft, one Save.
- The prompts read the saved behavior and say it in plain words. The apply tools also enforce the cover-letter policy when writing or attaching a letter: optional letter fields stay empty under "only when required", and "never" leaves a required letter for the person. A built-app check found that prompt instructions alone allowed an optional letter to be filled despite the saved restriction. This narrows the agent's actions to the person's choice; it does not widen permission. Final send, sign-in, account creation, and the aggressive-mode claim confirmations (ADR 0018) are unchanged by anything in this section.
- Stored fields stay where the code already reads them. The behavior preference and the letter preference are new settings fields; the search selectivity also writes `searchPreferences.discovery.collectOnlyHardCriteriaMatches` (best matches only turns the strict filter on). Search-preference writes go through the ordinary preferences save so the active plan's copy stays in step.
- The search selectivity replaces the per-run breadth toggle. Best matches only and cast a wide net force precision and scale mode; the middle setting defers to the plan's own mode, so scale plans keep their volume. The run-scoped `breadth` field stays in the contract for evaluation lanes, without a default.
- The older surfaces lose their copies: the tailoring dropdown and strict-collection checkbox leave Preferences, the original-versus-tailored cards leave the resume look card, the breadth toggle leaves the search bar, and the cover-letter card folds into the new section. A profile save carries the saved tailoring strength and filter through unchanged so it can never write a stale form value over a choice made in Settings.

## Consequences

- One place answers "how aggressive is this thing", and the answer is the same on every page.
- Defaults reproduce the behavior before the section existed, so an existing workspace changes nothing until the person does.
- Adding a new AI knob means adding it here and threading it to the prompt. The cover-letter restriction is also checked by the apply tools as described above. A knob that belongs to one run (the goal, recent only, which sources) stays on that surface.

Rejected alternatives: one setting per surface, each with its own save (what existed; the person could not find them); free-text system-prompt overrides (unbounded, untestable, and the copy would have to explain prompt engineering); folding the apply mode in as well (it is a permission, not a manner, and ADR 0022 keeps it as one switch under Applying).

## Related Decisions

- ADR 0012, ADR 0018, ADR 0022, ADR 0023, ADR 0024
