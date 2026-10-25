# Shortlist and tailored resume

The person shortlists the jobs they want. On Shortlisted, each job gets a resume level (Original, Light, Tailored, Aggressive) and "Create the resume" writes a resume for that job from the profile; the person can read it, edit it, or pick another level. When the resume is ready the next step is Apply.

## Sub-features

- `shortlist-add`: "Shortlist job" (or key S) in Find jobs' job details; the triage bar counts it ("N of M gone through") and offers Undo (key U). Outside a triage pass (a row's right-click menu) the toast says "Job added to Shortlisted." with Undo; a bulk shortlist says "Shortlisted N jobs." with Undo all.
- `shortlist-list`: Shortlisted page, plan combobox, one row per job with its state ("No resume yet", "Writing the resume…", "Ready to apply").
- `resume-level`: radiogroup "Resume level for this job" (Original, Light, Tailored default, Aggressive).
- `resume-create`: "Create the resume", progress bar "Resume preparation in progress", status "Resume created for this job."
- `resume-review`: the resume preview below ("Summary", "Experience", "Core Skills") and "Edit resume".
- `shortlist-remove`: "Remove from shortlist".

## How to get to it (user POV)

- Find jobs › select a job › "Shortlist job".
- Sidebar › Shortlisted.

## Driving it with verify-nestor

Preconditions: a finished search on `up --ai live`.

- **Shortlist.** In Find jobs, click a result in list "Results" (journey: `getByRole("list", { name: "Results" }).getByRole("button", { name: /^Frontend Engineer,/ })`), then `$V/drive click "Shortlist job"`, `$V/drive wait Undo --role button`. Proof: `$V/db saved_jobs 1 "<job title>"` with `status` `shortlisted` (or `drafting`).
- **Open Shortlisted.** `$V/drive click Shortlisted --role button --within "Job Finder sidebar destinations"`.
- **Create the resume.** `$V/drive click "Create the resume"`; wait until the progress bar "Resume preparation in progress" is gone and the "Apply" button shows. Measured 30 s for Tailored. Proof: shot of the preview, `$V/db resume_drafts 1`, `$V/db tailored_assets 1`.
- Whole flow: `journeys/job-finder-replica.mjs shortlist`, then `resume`.
- Not run through this skill yet: Edit resume, switching levels (rewrites the draft), Original (uses the file unchanged), Aggressive.

## Gotchas

- Shortlisting can start drafting in the background; the stored status may already be `drafting`.
- The fit shown here can differ from the search result: after shortlisting, the listing is read in full and assessed again.
- "Remove from shortlist" while writing stops the draft from being saved, but a running AI request may finish.
