# Contracts

Cross-package contract rules and the invariants a future agent is most likely to "fix" by mistake. Field-level detail lives in `packages/contracts` (JSDoc and README).

## Rules

- every external boundary gets a schema in `packages/contracts`
- prefer discriminated unions and explicit status enums over loose objects
- use narrow capability-based IPC payloads
- use typed result shapes for recoverable workflow outcomes
- do not import package internals across workspace boundaries

## Invariants

Each line names the symbol or file to check before changing the behavior. If the code looks over-strict, it is on purpose.

### Candidate assets and profile

- Raw paths, bytes, extracted text, and byte loaders never cross the renderer boundary; application upload receives a main-process-only `loadVerifiedBytes` capability and calls it immediately before upload (`workspace-application-attachments.ts`, `playwright-application-flow.ts`).
- Compensation matching compares only the saved minimum, and only when explicit currencies match; a null range maximum is not a ceiling, and missing or different currencies stay neutral and never infer an exchange rate (`matching-compensation.ts`).
- The fresh-start seed persists no fake facts: identity strings stay null and placeholder strings are never counted as real (`createFreshStartCandidateProfile`, `hasProfileSetupPlaceholderValue`).
- Setup readiness has one canonical rule and requires a runnable enabled public source, not an explicit target title (`evaluateProfileSetupReadiness`, `isRunnableJobDiscoveryTarget`).
- `STARTER_JOB_SOURCES` seed with `enabled: false` and never enable themselves; pristine legacy workspaces adopt them once (`adoptPristineWorkspaceStarterSources`).
- Long-running profile flows commit through the revision CAS boundary and retry a stale commit exactly once before surfacing a typed error (`commitMergedProfileUpdateWithStaleRetry`, `MAX_PROFILE_COMMIT_ATTEMPTS`).

### Resume export and approval

- Approved resume exports are written only through `approveResumeExport()`; both repositories throw on `upsertResumeExportArtifact` with `isApproved: true`, on purpose.
- Resume export intent is `approval | download`; `approval` renders and verifies without a native Save dialog (`ResumePdfExportIntentSchema`, `routes/job-finder.ts`).
- One rule decides whether a resume claim blocks export, and assistant proposals are gated by it before display (`isBlockingResumeClaimAssessment`, `evaluateResumeProposalGrounding`).
- Repositories retain only the newest revisions per draft and drop older ones deliberately (`MAX_RESUME_DRAFT_REVISIONS_PER_DRAFT`).
- Apply refuses a missing or stale approved resume and re-verifies file existence plus SHA-256 before any browser work (`workspace-apply-run-support.ts`).
- The approved answer-snapshot digest excludes lifecycle timestamps and the Profile revision so unrelated Profile writes cannot stale unchanged answers (`serializeApprovedApplicationAnswerSnapshotForDigest`).

### Discovery and ledger

- Only a `complete` inventory observation may transition a prior ledger identity to inactive (`inventoryCompleteness`, `collectionSupportsInactiveMarking` in `workspace-discovery-methods.ts`).
- `DiscoveryJobView.listingActivity` is snapshot-only; `SavedJob` deliberately does not persist it (`DiscoveryJobViewSchema = SavedJobSchema.and(...)`, `listing-activity.ts`).
- Service shortlist, product-action, and application gates each reject `listingActivity.status === "closed"` independently so stale UI cannot bypass closure; inactive and stale stay advisory.
- Identity resolution is collision-safe: zero, multiple, or conflicting candidates are no match, and title + company + location + date is a possible alias that never auto-merges (`job-identity.ts`).
- Compact observation refs are stale unless observation id and revision both match; payloads carrying selectors or handles fail closed (`DiscoveryCompactObservationControlRefSchema`).
- Discovery, source-debug, and apply consume the latest `draft` instruction artifact, otherwise the latest `validated` (`resolveActiveSourceInstructionArtifact`).
- A failed source-debug run keeps the previously verified guidance and its provenance instead of refreshing them (`preservedRouteHintArtifact` in `workspace-source-debug-workflow.ts`).
- Newest sorting uses `postedAt`, then `firstSeenAt`, then `discoveredAt`, never application workflow timestamps (`discovery-ordering.ts`).
- `dismissedDiscoveryJobs` is a separate projection that never enters ranking; restore returns a job to its recorded `priorStatus`.
- A discovery run result is `{ outcome: "completed" | "cancelled", snapshot }` and the snapshot is required in both variants (`JobFinderAgentDiscoveryResultSchema`).
- Company job ownership requires an exact canonical name or an alias with `identityAuthority: "user_approved_merge"`; legacy aliases default to `unknown`, and a domain corroborates but never owns jobs or scopes an exclusion (`company-intelligence-operations.ts`, `employer-exclusion.ts`).
- Application effort is explanation-only: Easy Apply lowers estimated effort, but `matching.ts` never reads `applicationEffort` into the score or ordering.

### Persistence and revisions

- `singleton_state.revision` only moves forward; unconditional saves increment it in the same upsert (`incrementSingletonRevision`, migration `singleton_state_revision`).
- The profile revision is a shared epoch: search-preferences and profile-setup-state saves also increment the `profile` revision, on purpose (`file-repository.ts`).
- `commitProfileUpdate(updater, { expectedRevision })` checks the revision inside the write transaction and returns the current profile without writing on mismatch.
- `listSavedJobs` is unbounded unless the caller passes `limit`/`offset`; `commitSavedJobDelta` is row-local, and full-replacement methods must never receive a page.
- There is no silent fresh start: an unrecoverable workspace fails with `WorkspaceDatabaseRecoveryRequiredError`, and `<workspace>.reset-backup` is deliberately excluded from automatic candidates (`file-repository-recovery.ts`).
- A migration error on a clean-integrity database is classified `not-corruption`: nothing is quarantined or rewritten.
- SQLite runs WAL with `synchronous = NORMAL`; close snapshots use `VACUUM INTO` and are database-only, so never describe them as full-workspace or zero-loss backups (`migrations.ts`, `file-repository-backup.ts`).
- The close-guard discard approval is a single-use, generation-bound token invalidated by crash, reload, or re-attach (`main-window-close-guard.ts`).

### Applications and safety

- Sending is envelope-bound: saved mode `prepare_only` never authorizes final submission, `ApplicationAutomationMode` is a distinct axis from `ApplyRunMode`, and `application-submission-runtime-main` has no production caller (`application-submission-policy.ts`).
- Submission evidence kinds are external only (`submissionOutcomeEvidenceKindValues`); there is no click or intent field, so intent can never prove submission.
- `outcome_uncertain` permanently blocks automatic retry and forbids `finalSubmitOccurred` (`SubmissionOutcomeRecordSchema`, `application-submission-orchestrator.ts`).
- `applicationPreparationStartedAt` and `applicationPreparationStartedLocalDate` are a pair: both absent is legacy unknown, both null is explicitly not begun (`apply.ts` refinement).
- One run prepares at most `MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN` jobs; there is no daily limit.
- `intermediateMutationsAuthorized` never authorizes final submission and requires exactly one job, one origin, and one resume digest (`application-authority-management.ts`).
- `externalWrites` records a write only after an authorized request receives a 2xx/3xx response; filled answers stay `answered` until an actual submission (`playwright-application-flow.ts`).
- Only login, signup, email-verification, and MFA blockers may resolve through source-access verification (`workspace-application-user-action.ts`); CAPTCHA and the rest wait for a capability-specific probe.
- User-owned blockers are not technical-failure evidence (`isUserOwnedBlockerEvidence`).
- The product-action registry exposes exactly the eight tools in `jobFinderProductActionToolNameValues`; none submits, creates accounts, or navigates arbitrarily.
- Visual snapshots are evidence-only: `visual.ts` rejects selectors and directives, and capture requires the explicit `captureVisualSnapshots` opt-in rather than inference from a visual-capable client.

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
