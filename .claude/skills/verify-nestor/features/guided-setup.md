# Guided setup and resume import

A new person starts on Profile › Guided setup. They pick their resume file (or enter details by hand); Job Finder reads it, fills the profile and asks only about the gaps over five steps: Import, Basics, Work history, Job targets, Extras. Setup can be finished once identity/contact, work history, a job source and work eligibility (countries, visa sponsorship) meet the readiness checks. Save and continue saves each step; imported details need review.

## Sub-features

- `setup-import-file`: "Recommended. Choose my resume file" opens the native picker; PDF, DOCX, TXT or Markdown; Basics and Work history then show "Ready to review".
- `setup-manual`: "Enter details manually" skips the file.
- `setup-basics`: name, headline, years, contact, location, links, summary; "Save and continue to Work history".
- `setup-work-history`: one card per role, education, projects, links, languages, proof; "Save and continue to Job targets".
- `setup-job-targets`: four blocks. "What to look for" (target roles, related areas, preferred locations, work modes, hours); "Where to look" (job sources, see `job-sources.md`); "Two answers every application asks" (Required: countries where you can work, visa sponsorship); "More about you (optional)", folded (relocation, remote, travel).
- `setup-finish`: "Finish setup and find jobs" once "Everything required is in. You can finish setup." shows.
- `setup-resume`: leaving and coming back to Profile resumes at the same step.

## How to get to it (user POV)

- A fresh workspace opens on it (heading "Guided setup").
- Profile in the sidebar while setup is unfinished.

## Driving it with verify-nestor

Preconditions: baseline. Live AI is optional here; the deterministic import works.

- **Import.** `$V/drive pick apps/desktop/test-fixtures/job-finder/resume-import-sample.txt`, then `$V/drive click "/Choose my resume file/"`, `$V/drive wait "/Basics.*Ready to review/" 90 --role button`. Proof: Basics shows "Jamie", "Rivers", "Staff Frontend Engineer", `dialogs.jsonl` shows the picker returned that file, and `$V/db profile_import_runs 1` has the run.
- **Basics and Work history.** `$V/drive click "/Basics.*Ready to review/" --role button`, `$V/drive click "Save and continue to Work history"`, then `"Save and continue to Job targets"`. Proof: heading "Job targets setup step"; the step list shows the earlier steps saved.
- **Job targets.** `$V/drive fill "Target roles" "Frontend Engineer"`, `press Enter`; `fill "Preferred job locations" "Remote"`, `press Enter`; `click "I can work in Germany"`; `click "No" --within "Would you need employer visa sponsorship?"`; `click Remote --role checkbox`. Add the source in the same step: `fill "Job site URLs" <replica>/board/`, `click "Add and turn on"`, `wait "/^Added and turned on 1 source/"`. Proof: "Everything required is in. You can finish setup."
- **Finish.** `$V/drive click "Finish setup and find jobs"` lands on Find jobs and starts the first search; use live AI for the full search/fit journey.
- Whole flow: `$V/drive run .claude/skills/verify-nestor/journeys/job-finder-replica.mjs setup`.
- Long text coverage: import `alex-vale-long.txt` and `alex-vale-long.md` separately with live AI. Compare all nine Engineer roles, BSc Computing at Example University, Mentor at Example Coding Club and the Family care break against Profile and the stored candidates. Entries recovered by completeness remain review suggestions.
- Other formats: pick a persona from `resume-import-personas/`. PDF and DOCX use the parser sidecar that `bin/build` prepares; vision import needs `--ai live`.

## Gotchas

- The picker is stubbed: `pick` must run before the click, and it answers exactly one dialog. Without it the dialog returns "canceled" and nothing happens.
- Imported details are shown for review without the old unsaved-details warning; use Save and continue to confirm the step.
- "Still needed to finish" at the foot of each step names what blocks Finish; read it before assuming a bug.
- Countries take one entry per Add; "I can work in Germany" appears because the imported location is Berlin.
