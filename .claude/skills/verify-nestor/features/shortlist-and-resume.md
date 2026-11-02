# Shortlist and resume

The person shortlists the jobs they want. With "Write resumes when I shortlist" on (the default, under Settings › Resume look), each shortlisted job gets a resume written at its Profile level (Light, Tailored, Aggressive); Original uses the imported file unchanged and still needs approval. On Shortlisted › To review the person reads it, edits it or picks another level, then approves it. Approved resumes wait under Approved for Apply.

## Sub-features

- `shortlist-add`: "Shortlist" (key S) in Find jobs' job details, or a selection's bulk "Shortlist N" (named with the ticked count; while rows are ticked the details' own Shortlist is an outline button). The job leaves Found jobs.
- `shortlist-list`: Shortlisted with the tabs "To review N" and "Approved N", a search box "Find a shortlisted job", one row per job.
- `resume-level`: the "Resume level" control in the resume pane; changing it writes the resume again and takes the approval off.
- `resume-write`: the pane's badge goes Waiting, Writing, then To review (or Not written with "Write again").
- `resume-review`: "Read or edit the resume", "PDF" downloads it. The page sits on a desk under a "Resume zoom" toolbar: a "Zoom preset" segmented choice of "Fit width" (the default) and "Actual size", then "Zoom out", the zoom percent (the only figure) and "Zoom in"; at the start, "1 page" or "Page N of M" for a longer resume. Arrow keys, Page Up/Down, Home, End and Space scroll the focused page and never reach the list's J/K handler. The page itself is a focusable region named "<Level> resume for <title>, N pages, NN%…"; with focus on it, + and − zoom, 0 fits the width and 1 is actual size. Original shows the imported file's name, kind and size, and "Open file" opens a read-only copy in the device's default app.
- `resume-approve`: "Approve <Level>" ("Approve Tailored", "Approve Original"; Ctrl+Enter approves and opens the next). The job moves to Approved and Apply can take it.
- `shortlist-remove`: "Move back" returns the job to Find jobs.

## How to get to it (user POV)

- Find jobs › select a job › "Shortlist".
- Sidebar › Shortlisted.

## Driving it with verify-nestor

Preconditions: a finished search on `up --ai live`.

- **Shortlist.** In Find jobs, click a row in the list "Found jobs" (journey: `getByRole("list", { name: "Found jobs" }).getByRole("button", { name: /Frontend Engineer/ })`), then `$V/drive click "/^Shortlist/" --role button --within "Job details"`. Proof: `$V/db jobs 1 "<job title>"` with `stage` `shortlisted`.
- **Open Shortlisted.** `$V/drive click "/^Shortlisted/" --role button --within "Job Finder sidebar destinations"`.
- **Approve.** Wait for the pane's badge: `$V/drive wait "/^(To review|Not written)$/" 600 --within "/^Resume for /"`, then `$V/drive click "/^Approve (Original|Light|Tailored|Aggressive)$/" --role button` (the button names the level it approves, "Approve Tailored"). Proof: `$V/db resumes 1` with `state` `ready` and `approved_at` set.
- Whole flow: `journeys/job-finder-replica.mjs shortlist`, then `resume`.

## Gotchas

- Shortlisting starts the resume in the background; the stored state may already be `writing` or `ready` when Shortlisted opens.
- Approve stays disabled until the resume is written.
- A level change after approval takes the approval off until the person approves the new resume.
