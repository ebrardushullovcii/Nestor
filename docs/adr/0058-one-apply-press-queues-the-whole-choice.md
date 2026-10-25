# ADR 0058: One Apply press queues the whole choice

Status: superseded by the owner’s Job Finder rewrite (2026-10-25).

Apply now admits approved jobs into indexed `applications` rows through `applyJobs`, using ids or a filter selection. The runner claims bounded concurrent work directly from those rows; there is no singleton queue or ten-job batch path. An interrupted preparation may resume, while an interrupted send requires a confirmed receipt or remains uncertain. The mode captured at Apply and the current permission bound every send. Approval is read from `resumes` beside `jobs`, with no legacy approval fold. The historical decision below does not describe the current runner.

## Context

One Apply press starts at most ten applications (ADR 0012, ADR 0036). The owner applies at volume: about 200 shortlisted jobs. With the ten-job ceiling back, "Apply to all" became "Apply to next 10", pressed again and again. ADR 0043 already decided that bulk work queues the whole selection, and ADR 0045 that a saved batch survives a restart.

## Decision

- Shortlisted offers Apply to the selected jobs, to the jobs on this page, and to all ready jobs. Each choice becomes one saved Apply queue.
- The queue starts runs of at most ten, one after another, with no further press. The ten-job run ceiling, site serialization and every send check stay as they are; each run is the same start as Apply to all.
- The queue is saved (`apply_queue` singleton) and carries on after a restart by itself. Unlike ADR 0045's resume batches, there is no Continue press: the person already chose these jobs and the mode. A job is marked taken before its run starts, so a restart never starts it twice.
- A run never uses a mode that allows more than the one the press was made in or the one saved in Settings now; turning off Send for me stops later runs from sending.
- Pause lets the run under way finish and starts nothing new; Stop cancels the run under way. "Pause new work" holds the queue too. A refusal that affects the whole queue (a global pause or an abnormal failure rate) pauses it with that sentence and Continue tries again. A same-company conflict sets aside only the named conflicting jobs, counts them as not applied with their reasons, and carries on with the rest. It grants no permission to send either conflicting job.
- Jobs a run leaves out (a resume waiting for the person, a PDF that could not be made, already applied) are listed with their reason instead of being dropped.
- Home's Happening now and Applications show the queue with Pause and Stop.

## Consequences

Applying to 186 jobs is one press. Throughput and safety are unchanged per run. Reset everything removes the queue.
