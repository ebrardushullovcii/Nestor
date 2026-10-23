# ADR 0058: One Apply press queues the whole choice

Status: accepted (2026-10-23).

## Context

One Apply press starts at most ten applications (ADR 0012, ADR 0036), and the saved daily limit (twenty by default) caps a day. The owner applies at volume: about 200 shortlisted jobs. With the ten-job ceiling back, "Apply to all" became "Apply to next 10", pressed again and again, and nothing carried on once the day's limit was used. ADR 0043 already decided that bulk work queues the whole selection, and ADR 0045 that a saved batch survives a restart.

## Decision

- Shortlisted offers Apply to the selected jobs, to the jobs on this page, and to all ready jobs. Each choice becomes one saved Apply queue.
- The queue starts runs of at most ten, one after another, with no further press. The ten-job run ceiling, the daily limit, site serialization and every send check stay as they are; each run is the same start as Apply to all.
- When today's limit is used, the queue says so and waits. It carries on by itself a second after local midnight, or at once when the person raises the limit.
- The queue is saved (`apply_queue` singleton) and carries on after a restart by itself. Unlike ADR 0045's resume batches, there is no Continue press: the person already chose these jobs and the mode, and the daily limit still bounds every day. A job is marked taken before its run starts, so a restart never starts it twice.
- A run never uses a mode that allows more than the one the press was made in or the one saved in Settings now; turning off Send for me stops later runs from sending.
- Pause lets the run under way finish and starts nothing new; Stop cancels the run under way. "Pause new work" holds the queue too. A run that cannot start (a Safeguards review, a same-company conflict) pauses the queue with that sentence and Continue tries again.
- Jobs a run leaves out (a resume waiting for the person, a PDF that could not be made, already applied) are listed with their reason instead of being dropped.
- Home's Happening now and Applications show the queue with Pause and Stop.

## Consequences

Applying to 186 jobs is one press that takes about ten days at twenty a day. Throughput and safety are unchanged per run and per day. Reset everything removes the queue.
