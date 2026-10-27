# Job sources

Job Finder searches the sites the person adds. Sites live in the indexed `job_sites` table, independently of Profile fields. Adding, editing, switching and removing a site writes only the affected rows. Profile, setup and the Find jobs picker request pages of 25 sites.

## Entry points

- Guided setup > Job targets > Where to look: the `Job site URLs` textarea accepts several addresses. `Add and turn on` saves them and explains duplicates or invalid entries. Save, Continue and Finish also flush a pending textarea before leaving the step.
- Profile > Job sources: `Add sources` opens the same textarea. The shared list/detail layout has `Find a source`, All/Enabled/Disabled/Needs attention, selection and Turn on/Turn off. `Previous sources` and `Next sources` page the list. Select a row to edit Source name, Starting page URL and Source notes; edits save on blur. `Include this source in searches` switches just that row. `Remove` removes the site and keeps its saved jobs.
- Find jobs > the sites button opens `Sites to search`. Only enabled sites appear. All/None, `Find a site`, per-site checkboxes and Previous/Next work across pages. Selecting all except one keeps a compact exclusion, rather than downloading or sending every id.
- `Open site`, `Check source` and the learned-guidance review remain in the Profile detail pane. Source-debug updates guidance pointers on the site row.

## Driving it with verify-nestor

Use this instance's replica URLs only. A synthetic profile may be seeded when import is not the feature under test; say so in the result.

- In setup, fill `Job site URLs` with `<sites>/board/` twice and press Save and continue. Assert one enabled `job_sites` row. Return to Job targets, then Finish: setup completes and the first search starts using the site row independently of the saved goal fields.
- In Profile, bulk-add replica addresses, including an existing address and an invalid one. Keep the duplicate/invalid feedback, then correct the remaining input. Assert only the changed `job_sites` rows are written.
- For a large list, add 900 distinct replica paths without searching them. Assert only 25 list rows and a 25-row `list_sites` response, page forward, find the last URL, rename it, switch it off/on and inspect that row in `job_sites`.
- In the picker, assert 25 checkboxes, find the last URL, exclude it and check the count; then None and select board/lever/greenhouse. Run a live search and repeat. Assert only those three site rows receive last-searched/health/lane metadata, descriptions remain full text, and the repeat makes no AI calls.
- A 900-row UI check does not prove a 900-source search. Measure the scheduler separately.

## Counts

Per-source inventory notes report listings observed on the site. The old source-health result is a retained count and says `jobs kept`; it must not claim that is the board's total listing count.

## Gotchas

- The default `--net replica` refuses requests outside loopback. Use `--net web` only for authorized read-only checks and never send a real application.
- A restarted verify instance may get a different replica port. Update stored site URLs before another search.
- The sidebar uses the same list_sites/get_site/add_sites/update_site/remove_site/set_sites_enabled commands as the screens. Changes have separate persisted Undo receipts; later site edits are preserved. Ask to show Profile > Job sources after the change, then compare the screen with job_sites.
