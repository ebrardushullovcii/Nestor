# ADR 0062: Keep prepared discovery fingerprints with saved jobs

Status: accepted (2026-10-24).

`packages/contracts` owns the enumerable `Symbol.for("nestor.discoveryPreparation")`
slot and its typed preparation helpers. Spreads and `copyView` carry the slot;
JSON, IPC and `structuredClone` omit it. Explicit worker payloads carry only the
preparation values they need and reattach them in main. A trusted frozen owner row can
read its stored fingerprints without touching the listing body; changed copies
must still match the exact fingerprint input fields. Mutable producers use a
captured input basis; an unfrozen owner is never proof that inputs stayed unchanged.

`saved_job_discovery_fingerprints` stores one typed fingerprint value per saved-job
id. The job's transaction writes or invalidates it, and deleting the job removes
it. A batch repository method performs one indexed query for all requested ids,
without reading job bodies or retaining another cache. Missing values mean that
search prepares the posting once and supplies the result with the next job write.
No matching, scoring, collision or relevance policy moves into storage.

The table is additive and initially empty: creating it does not scan or transform
existing saved jobs. There is no hash backfill, duplicate JSON field, downgrade
shape or separate identity store. Forward migrations that transform the saved-job
body remain subject to backup and count verification under ADR 0061.
