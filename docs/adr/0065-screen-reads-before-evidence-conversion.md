# ADR 0065: Prepare screen reads before converting evidence

Status: accepted (2026-10-24).

The first launch after an update spent tens of seconds converting stored search
runs, resumes and job evidence on Electron's main thread. None of that evidence
is needed to show Home or the first page of jobs.

One temporary worker starts before Electron is ready. It prepares the scalar
read index and signals that typed screen queries can read SQLite. Existing
unnormalized rows supply the same scalar facts until evidence conversion ends.
The existing intake and display functions prepare their scalar values; no new
matching or scoring policy is introduced. The worker then runs the forward
migrations with their backups and checks. The canonical workspace service waits
for that conversion before opening its writer. The worker exits afterward.

The main thread continues to answer ordinary typed read IPC from a read-only
connection while conversion runs. There is no saved workspace view, second
canonical database, recurring read poll or permanently running reader process.
Canonical opening still owns corruption recovery and authorization recovery.

Search-run progress and saved-job evidence conversion use set-based SQL. Job
conversion validates old records once, preserves incomplete repair rows and
stored preparation, and verifies the exact reconstructed canonical facts before
commit. The read index is rebuilt inside that transaction so a reader observes
either the previous complete index or the converted complete index.

Find jobs queries expose the existing four result bands and exclude jobs already
decided on. Default counts include matches and unchecked rows. Complete listing
activity and renderer migration remain explicit acceptance gates under ADR 0060.

The existing per-window query-update mode also suppresses inventory arrays in
that window's legacy sync and mutation replies. Other windows retain their
current complete legacy projection. This removes duplicate queried rows without
changing canonical service reads or introducing another product setting. Query
routes still avoid legacy sync entirely; remaining history moves with its screen.
