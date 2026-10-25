# ADR 0011: Local application tracker

## Status

Accepted. The campaign part of this decision (search plans) is cut by the 2026-10-25 scope in `docs/PRODUCT.md`; the tracker part stands.

## Context

Applications must be tracked after they are prepared or sent by hand. The existing application execution state is safety-sensitive: `submitted` means a real external submission was observed. A user manually tracking an application as Applied must not manufacture that browser-execution fact.

## Decision

- Add a defaulted tracker payload to each application record for lifecycle stage, timeline, contacts, reminders, interviews, notes, file references, tags, and compensation/offer details.
- Keep tracker truth separate from browser execution truth. Manually selecting Applied or a later employer stage updates the tracker payload and timeline but never changes a preparation record to `submitted`, never creates a submission timestamp, and never grants submit authority.
- Derive counts, rates, and next actions from persisted local facts. Missing evidence remains unavailable instead of being estimated.
- Connected email/calendar detection needs later typed integrations and separate permission.

## Rejected alternatives

- Reuse `ApplicationRecord.status = submitted` for manual Applied tracking: rejected because it would falsely claim an external action occurred.
- Store tracker state in a separate untyped database: rejected because it would split the local source of truth.
