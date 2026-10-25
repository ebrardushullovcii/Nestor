# ADR 0034: Stepping into the browser hands over one tab, and handing it back carries on

Status: accepted (2026-09-24).

Supersedes the takeover bullet of ADR 0024 ("the run using it ends with that reason") and the takeover sentence of ADR 0017 ("it pauses workspace activity, cancels operations and disconnects automation").

## Context

A person's click in the embedded browser used to stop every run in it: three source searches and an application alike, because the browser could not tell which run used which tab. It also dropped the automation connection, so every filled-in page lost its binding, and it left the browser paused, so Home's Search now failed with "Browser activity is paused" until the person found Resume agent. Nothing carried on after Resume agent; the stopped application read Could not apply, and a stopped batch stranded its remaining jobs. Separately, the person's first click on a parked sign-in tab cleared the only "needs you" slot, so the sign-in watcher (gated on that slot) never resumed the search, and a second click in that tab stopped all other work.

## Decision

- Every run tells the browser which tab it works in; the automation connection itself reports the tab each page command reaches, so no URL is compared.
- A person's click or keypress in a tab stops only the runs working in that tab. The tab stays open and is taken away from automation while the person holds it; other runs keep their tabs and their connection. Nothing is paused globally; a person's deliberate start (Search now, Apply) always works.
- Resume agent hands held tabs back and carries on the applications stepping in stopped, in the saved mode, as the Try again the person would otherwise press. An application inside a batch that is still working through other jobs carries on when that batch ends. The fresh attempt starts from the job's page again.
- A tab parked for the person (a source sign-in or check) keeps its own banner and stays away from automation; helping there never stops other work, however many clicks it takes. The sign-in watcher reads that exact tab, not any tab on the same site, and is not gated on the banner.
- A tab the person opens themselves is theirs: no run reuses, navigates or closes it.
- Input the agent sends through the automation connection is never mistaken for the person's, even with the pointer moving over the view.
- An application the person stepped into is recorded as "You took over this application.", not as a failure on the site.

## Consequences

- Closing the browser from its menu, and Home's Pause, still stop everything; background work waits for the person's next deliberate start.
- What the person typed into a taken-over application is not kept when it carries on; the new attempt fills the form again from the profile.
- Rejected: pausing the whole browser on any click (the old behaviour; it failed unrelated searches), and waiting inside a batch for the person to hand back (one held tab would stall every later job).

## Related Decisions

- ADR 0017, ADR 0024, ADR 0027, ADR 0033
