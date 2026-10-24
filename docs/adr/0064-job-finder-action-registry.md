# ADR 0064: One list of Job Finder actions

Status: accepted (2026-10-24).

## Context

The sidebar covered most routine work, but queues, company notes, documents,
resume approaches and several recovery controls were missing. Separate tool
schemas and route bodies made the inventory overstate what worked. The owner
asked for every user action under the same rules, less code, and simple
requests that take 3–5 seconds.

## Decision

- `assistant/action-registry.ts` is a plain list: shared contract schema,
  safety class, description, and service call. Desktop handlers dispatch
  through it. Main-owned files, browser pages and authority operations reuse
  their existing operations rather than calling IPC from another handler.
- The catalog generates tools from this list. Existing conversational tools
  remain only where they add necessary behavior: instruction grants, unsaved
  edit protection, Undo, multi-job work or browser leases. Moving a tool must
  preserve that behavior. Four simple wrappers are replaced by generated tools.
- Input is validated at the IPC/model/file boundary. Stored assistant rows
  written through validated repository methods are trusted on read. Queue
  authorization reads frozen conversation/job bindings from the queue itself,
  then checks current instruction grants before each run. Deleting the chat
  leaves the binding in place and removes its grants, so no later run sends.
- A destructive or hard-to-undo action creates the existing proposal card.
  Only the person's Apply press executes it, with current service checks.
  Duplicate presses share one pending execution. Reset and restore finish
  their confirmation record before replacing the chat they belong to.
- Application starts use the same durable queue as the buttons: runs of ten,
  the saved mode and daily limit, midnight/restart continuation, pause and
  removal. Preparing and sending keep the instruction-grant and submission
  boundaries from ADRs 0012, 0024 and 0039. No generic action tool bypasses them.
- The model chooses tools. The initial catalog is small; `load_tools` loads
  groups or exact names on demand. There is no request keyword/regex router.
  The base prompt is shorter and retains the safety and answer-quality rules.
- For a simple action the model may set `complete: true`. A tool may finish
  from its verified receipt only after full success, avoiding a second model
  call to paraphrase a saved result. Conflicts, partial work, explanations,
  other calls and earlier failures still return to the model. The full result
  and reply remain in the transcript.
- Shortlist time is stored when a job enters Shortlisted, so “last shortlisted”
  is not guessed from posting dates. Older undated jobs stay explicitly undated.
  Triage and source edits record exact Undo receipts; later changes are retained.

## Consequences

Adding an ordinary action requires one registry entry. It becomes reachable
through the model's on-demand catalog and is covered by the catalog/input tests.
Host operations remain in Electron main, persistence stays behind repository
interfaces, and the renderer still uses only the typed preload bridge.

The 3–5 second target requires live measurements of total time, AI time, input
tokens and app overhead. Fewer tokens or a synthetic test alone does not prove
latency or answer quality.
