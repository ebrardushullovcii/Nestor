# Contracts

Cross-package contract rules and the invariants a future agent is most likely to "fix" by mistake. Field-level detail lives in `packages/contracts`.

## Rules

- every external boundary gets a schema in `packages/contracts`
- prefer discriminated unions and explicit status enums over loose objects
- use narrow capability-based IPC payloads
- use typed result shapes for recoverable workflow outcomes
- do not import package internals across workspace boundaries

## Invariants

Each line names the symbol or file to check before changing the behavior. If the code looks over-strict, it is on purpose.

### Candidate assets and profile

- Candidate-asset paths, bytes and loaders stay in main; Profile resume metadata omits `storagePath` and `textContent`. Application attachments receive a main-process-only `loadVerifiedBytes` capability (`profile-store.ts`, `workspace-application-attachments.ts`, `agent-application-preparation.ts`).
- Compensation matching compares only the saved minimum, and only when explicit currencies match; a null range maximum is not a ceiling, and missing or different currencies stay neutral and never infer an exchange rate (`matching-compensation.ts`).
- The fresh-start seed persists no fake facts: identity strings stay null and placeholder strings are never counted as real (`createFreshStartCandidateProfile`, `hasProfileSetupPlaceholderValue`).
- Setup readiness requires a name, one contact method and an enabled site, not an explicit target title (`evaluateProfileSetupReadiness`).
- Profile copilot commits use the revision CAS boundary and retry a stale commit exactly once before surfacing `ProfileCommitStaleError` (`commitProfileCopilotStateWithStaleRetry`, `MAX_PROFILE_COMMIT_ATTEMPTS`).

### Resume export and approval

- Approval checks the saved resume's `updatedAt` before recording approval and moving a shortlisted job to `resume`; an edit or level change clears approval (`resumes/resume-service.ts`, `job-store/resumes.ts`).
- Download PDF uses the native Save dialog and neither approves nor saves unsaved typing (`ResumePdfExportInputSchema`, `routes/resumes.ts`).
- Apply requires an approved, ready resume and checks the file's SHA-256 before browser preparation, then rechecks it at upload (`applications/application-service.ts`, `applications/resume-artifacts.ts`).
- The approved answer-snapshot digest excludes lifecycle timestamps and the Profile revision so unrelated Profile writes cannot stale unchanged answers (`serializeApprovedApplicationAnswerSnapshotForDigest`).

### Discovery

- Repeated discovery merges jobs by normalized URL or source identity and preserves their stage; title, company and location may merge sightings across sites (`job-store/found-jobs.ts`).
- Page actions use the current observed refs and reject a changed page signature; raw selectors are not a substitute (`page-tools.ts`).
- Apply and source-debug prefer the site's referenced draft instruction, then its referenced validated instruction (`resolveActiveSourceInstructionArtifact`); search prefers the referenced validated instruction, then the draft (`job-search/engine.ts`).
- A source check that fails verification keeps the referenced validated instruction and saves its new guidance as a draft (`preserveExistingValidatedInstruction` in `workspace-source-debug-workflow.ts`).
- `newest` sorts by `found_at`, `posted` by `posted_at` then `found_at`, and `recent` by `stage_at`; every order ends in `id` (`job-store/job-list.ts`).
- Hidden jobs stay out of Find jobs ranking; triage moves and Undo operate on stored stages (`job-store/job-moves.ts`).

### Persistence and revisions

- `profile_revision.version` advances once per transaction that reports a profile change; profile, goals and setup share that CAS epoch (`job-store/job-store.ts`, `job-store/profile-workspace.ts`).
- `commitProfileUpdate(updater, { expectedRevision })` checks the revision inside the write transaction and returns the current profile without writing on mismatch.
- Job lists are cursor pages, defaulting to 50 and capped at 200; mutations use ids or a filter selection, never a page as a replacement collection (`JobListQuerySchema`, `JobSelectionSchema`).
- The job store uses WAL with `synchronous = NORMAL` and additive schema changes. Only a file older than `JOB_STORE_KEPT_FROM_VERSION` is deleted and recreated (`job-store/job-store.ts`).
- The close-guard discard approval is a single-use, generation-bound token invalidated by crash, reload, or re-attach (`main-window-close-guard.ts`).

### Applications and safety

- Sending is envelope-bound: saved mode `prepare_only` never authorizes final submission, `ApplicationAutomationMode` is a distinct axis from `ApplyRunMode`, and the application service calls the submission runtime through preflight and idempotency guards (`applications/application-service.ts`, `application-submission-runtime.ts`).
- Submission evidence kinds are external only (`submissionOutcomeEvidenceKindValues`); there is no click or intent field, so intent can never prove submission.
- `outcome_uncertain` blocks automatic retry and forbids `finalSubmitOccurred` (`SubmissionOutcomeRecordSchema`, `application-submission-orchestrator.ts`).
- `intermediateMutationsAuthorized` never authorizes final submission. A saved autosave grant requires explicit jobs or a campaign, at least one resume digest and an expiry; grants may cover multiple jobs and origins (`application-authority-management.ts`).
- Preparation records filled fields and attachment activity in `externalWrites` with `verified: false`; this is not proof of a server save or submission (`toExternalWrites` in `agent-application-preparation.ts`).
- Access blockers become typed sign-in, CAPTCHA or MFA tasks; continuation re-observes the retained application page (`accessKind`, `checkApplicationAccess` in `applications/application-service.ts`).
- Open form questions and remembered answers belong to Needs you; answering queues only waiting attempts whose remaining tasks are resolved, without granting send authority (`job-store/needs-you.ts`).
- Visual observations are evidence-only: `visual.ts` rejects selectors and directives. Apply visual diagnostics require explicit capture and analysis callbacks (`buildApplyVisualDiagnostics` in `playwright-browser-runtime.ts`).

### AI providers and Live Assistant

- Image routes have their own default model, API mode, and reasoning setting and never inherit the text defaults (`DEFAULT_VISION_MODEL*` in `openai-compatible-transport.ts`).
- A resume-import stage that fell back to the deterministic reader keeps `status: "completed"`; `fallbackKind` and `fallbackReason` are the only durable degradation record (`resume-import.ts`, `describeResumeImportStageFallback`).
- Disclosure acceptance does not imply capture: `microphoneCapture`, `meetingAudioCapture`, and `screenshotCapture` are enforced separately (`InterviewSetupConsentSchema`).
- Empty or non-speech audio results are ignored, not persisted as transcript segments (`NON_SPEECH_TRANSCRIPT_PATTERN`).
- `InterviewCaptureProtectionStateSchema` is a six-state enum; never collapse it into a boolean.
- Live Assistant writes back to Job Finder only through `JobFinderInterviewFollowUpInputSchema`.

## Validation Expectations

- normalize browser extraction through schemas before saving jobs
- validate provider output before workflow code uses it
- keep import, source-debug, apply, and Live Assistant artifacts replayable and auditable
- store screenshots only through typed evidence refs or checkpoint metadata with explicit retention/redaction decisions
