# ADR 0053: The window opens on the view the last clean close saved

Status: accepted (2026-10-21).

Amended by [ADR 0055](0055-saved-job-details-stay-in-sqlite.md) on 2026-10-23: compatible clean views also survive a main-process update. The original decision below records the initial build restriction.

## Context

On the owner's workspace (6,284 saved jobs, 897 sources, a 210 MB database) the window showed Home after about 3.3 s and finished loading after 6.3–6.9 s. Most of that was the main process reading and validating every saved job and search record, then sending one 35 MB snapshot. Each start also ran a full SQLite integrity check (about 0.3 s), even when the file was exactly as the last clean close left it.

## Decision

- On a clean quit, after the database closes, main records a fingerprint of the closed file (size, modification time, header page) next to it.
- In the same quit, if no search or application is running, main saves the opening bootstrap and the full window view, with that fingerprint and the identity of the main-process build, in `job-finder-startup-view.bin` in the user-data folder.
- On the next start main reads the fingerprint before anything opens the database. When the file is unchanged and the build is the same, the window's first bootstrap and first full sync are answered from the saved view at once. Main then loads the real workspace and tells the window, which converges by the ordinary delta sync. Rows that differ only in their detail revision are not resent.
- The saved view is used once and deleted when read. A crash, a leftover write-ahead log, an outside edit, a reset or a new build means no view: the start is the ordinary one.
- The same fingerprint lets a start skip the full integrity check, since nothing could have changed the file. Any other start still runs it.
- If the real workspace then fails to load, the window reloads into the ordinary path, which shows the failure or the database recovery screen.

## Consequences

- The window shows the person's data about 2.4 s after launch instead of 6.3–6.9 s. Actions the person takes in the first seconds wait for the real workspace in main, as before.
- Quitting takes a little longer: one more workspace read and a 30 MB file write after the close backup.
- For a moment after start the window can show time-relative facts as of the last quit (for example a plan that became due overnight); the first delta corrects them.
- The view file holds the same data as the workspace database and lives beside it.

## Related Decisions

- ADR 0046 (normalized discovery storage), ADR 0045 (resume batches continue after restart).
