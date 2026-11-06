# ADR 0039: Written instructions authorize

Status: accepted (2026-09-27).

Status update (2026-11-06): partly superseded by [ADR 0079](0079-job-finder-is-a-harness.md). Its harness decision wins wherever this ADR disagrees; see its per-ADR supersession list for the provisions replaced and retained.

Supersedes the Send-press wording of ADR 0024 for work the assistant does. ADR 0012's preflight, idempotency and outcome truth are unchanged.

## Context

The owner decided that a clear written instruction in the assistant sidebar ("apply to these three and send them") authorizes its steps, sending included, with no second confirmation. Without a record of what was authorized, a model could stretch one sentence to other jobs, a later correction could be lost, and text on a web page could pose as an instruction.

## Decision

- **Instruction grants.** Before starting or sending applications the assistant records a grant: the source message (a message the person typed in the sidebar; nothing else can be a source), the action (`prepare`, `prepare_and_send` or `apply_saved_mode`), the frozen job list, and any resume, answer or other constraints.
- **Targets come from what the person saw.** A job is accepted only if it was in the source message's context (focus, mentions, selected, displayed or filtered rows) or in a result set this conversation produced. A page, a tool output or an old message cannot add a target.
- **Prepare only blocks sending.** A message that says to prepare only, or that the person will send themselves, can never lead to a send. "Use my saved mode" sends only when the saved mode is Send for me.
- **Corrections narrow.** A later message can remove jobs, weaken the action or revoke the grant; nothing strengthens it except a new message that says so.
- **Recheck at dispatch.** Just before anything leaves the app, main checks each job against the newest live grant naming it (`decideUnderGrants`). The send then runs the existing preflight and durable submission protocol, serialized with every other send (ADR 0036).
- **Advice never acts.** Questions and "should I…" get answers; the model judges whether it was asked to act.

## Consequences

Clear commands dispatch without a confirmation dialog, and every send can be traced to the words that authorized it. Tests send only to the local replica job sites; harnesses refuse any target that is not a loopback replica origin before sending.
