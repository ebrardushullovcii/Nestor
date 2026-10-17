# ADR 0026: Shortlisted is three steps per job, and one decision list in the resume

Status: accepted (2026-09-20). Resume selection and batch concurrency are amended by [ADR 0035](0035-selected-resume-batches.md). The "Lines to confirm" list is removed by [ADR 0051](0051-the-app-fixes-what-it-can-and-does-not-ask.md).

## Context

Shortlisted had grown into the product's densest page. One job's column carried a "Preparation readiness" eyebrow, an "Application readiness" card with six facts, a four-item checklist, a "What happens when you prepare" disclosure, a "Batch actions" section with per-row "Select for batch" checkboxes, a per-batch apply-mode choice, "Prepare selected jobs", "Resumes for this batch", and a "More actions" disclosure. ADR 0022 had already decided that applying is one control per job plus "Apply to all shortlisted", with the mode chosen once in Settings, but the page still carried the surface the ADR removed.

In Resume Studio, an Aggressive draft (ADR 0018) showed the same flagged line twice: once in a "Claim confirmations" panel with "Confirm this wording", and once in the "Fix before approval" list as a "Blocks approval" row with "Approve as accurate". The product owner, who uses Aggressive, found the review step "too much" and hit a real defect: after confirming every visible line, approval still failed. The export gate re-checks the draft and saves what it finds, but the studio never reloaded that result on failure, so the newly flagged lines were invisible until the app was restarted.

Apply itself was also disorienting: the person pressed it on Shortlisted and stayed there for minutes watching one button say "Filling in the form…", and was moved to Applications only when the run ended.

## Decision

- Shortlisted keeps its name (the flow is Find jobs → Shortlisted → Applications) and its page says what it is for: "The jobs you want. Pick a resume level for each, get the resume ready, then press Apply." One job's column is three steps in that order: the resume level, one Next step block (a state line, one button, and one sentence saying what Apply does in the mode chosen in Settings), then the resume, then the job facts. Two quiet links, "Open the listing" and "Remove from shortlist", are the only other actions.
- The list has no batch curation. When two or more jobs are listed, one row offers "Create N missing resumes" (the existing sequential first-draft run) and "Apply to all N ready jobs" (ADR 0022's "Apply to all", capped at the per-run limit). Jobs already in Applications and jobs whose application is running are left out of the ready count.
- Pressing Apply goes to Applications at once, with that job selected, so the person watches Filling in → Ready to send / Applied / Needs you there. Until the run has written its record, Applications stays a usable list with one status line saying the application is starting (a blocking full-page state parked a tester for minutes), and a job with several records resolves to its newest one.
- In Resume Studio, a line that needs the person's confirmation appears in exactly one place, the "Lines to confirm" list, with two verbs: Keep (records the ADR 0018 ownership statement for that exact wording) and Remove. Skills the job asked for can be kept together; wording lines are kept one at a time, as the service already requires. The validation list no longer repeats those lines. Claims that contradict the evidence stay in the validation list, where Edit, Restore previous text, and Approve as accurate live.
- When approval or export is refused, the studio reloads the workspace before showing the message, so the fresh list is what the person sees. The refusal says "Some lines in this resume still need your decision" and names the list.
- Row and state vocabulary is one set of plain words: No resume yet, Writing resume, Review resume, Ready to apply, Applying, In Applications, Resume failed, Out of date.

## Consequences

- Removed: readiness facts, checklist, "What happens when you prepare", "Select for batch" checkboxes and their persisted per-campaign curation, per-batch apply-mode cards, "Prepare selected jobs", "Resumes for this batch", "More actions", and the duplicate claim rows in the validation list.
- The per-run cap (10) and the daily cap are unchanged; "Apply to all" takes the first ten ready jobs in list order.
- The Assistant's empty thread offers three ready questions, the first being "What would you change to fit this job better?", so asking what to change is one press.
- Release-acceptance harnesses that asserted on the batch checkboxes (`capture-scale-500`, `validate-job-finder-production-acceptance`) describe a surface that no longer exists and need their Shortlisted steps rewritten before the next release candidate.

Rejected alternatives: renaming the destination to "Apply" (collides with "Applications" one step later, and the list is still the shortlist); a "Keep all" for wording lines (the service deliberately confirms wording one line at a time, ADR 0018); keeping the batch checkboxes for power users (nobody in the usability panel used them, and ADR 0022 had already replaced them).

## Related Decisions

- ADR 0018, ADR 0022, ADR 0023
