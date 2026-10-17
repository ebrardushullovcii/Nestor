# Job Finder

## Purpose

Owns profile, resume import, discovery, source-debug, resume workspace, review queue, applications, and apply orchestration. The user flow is Profile -> Find jobs -> Shortlisted -> Applications; Needs you, Activity, and Settings support that flow without adding steps.

## Hard Rules

- Keep boundaries typed through `packages/contracts`.
- Do not hardcode one job board's routing, query maps, triage overrides, or recovery behavior into shared discovery (ADR 0007). Reusable provider adapters (Ashby, Workday, Lever) are fine; board-specific workflow policy is not.
- Preserve resume approval and stale-state checks before apply. Tailored mode requires current approval; original mode attaches the unchanged imported file without generating a draft.
- Refuse shortlist and preparation for a listing with derived `closed` activity; keep `inactive`, `stale`, and `unknown` truthful rather than treating them as closure.
- Send only inside the saved authority envelope: Send for me after preflight, Ask before sending on the person's Send press, never under Prepare for me (ADR 0012, ADR 0024, ADR 0027). The assistant may also send under a recorded grant from a written sidebar instruction; a prepare-only instruction never sends, and every grant is rechecked at dispatch (ADR 0039). Sign-in recovery waits for an explicit "I'm signed in, retry" action; the app never receives or stores credentials.
- Treat browser visual evidence as schema-validated review/recovery context only.
- Never persist a paged or stale saved-job collection through a destructive replacement API; ordinary mutations use the row-local repository commit.
- Employer exclusion is exact-name, previewed, atomic, and reversible. Domain evidence may corroborate identity but never becomes a domain-wide exclusion.
- Company ownership requires an exact canonical name or a user-approved merge alias; legacy aliases and domains never own jobs.
- Application documents fail closed on stale question/application lineage.
- Safeguards: at most 10 unique employer jobs per preparation run (fixed) and the person's daily limit of begun employer applications from Settings › Applying (default 20). These are migration defaults, not a product ceiling, but any replacement must be explicit and bounded by the user's authority envelope.
- Every covering surface (dialogs, menus, palettes) registers through `useJobFinderOverlayOwnership` so one Escape closes only the topmost layer. Rapid-review j/k/x keys and the Resume Studio preview iframe stay outside that registry on purpose.
- One assistant serves every Job Finder screen from the right-hand sidebar (ADR 0037). It opens only when asked. Asked-for edits apply with a per-change Undo and never overwrite unsaved typing; suggestions stay proposals. It works in the browser only in the tab lent to it (ADR 0038). New visible actions need an entry in `packages/job-finder/src/assistant/action-inventory.ts` and a tool, or a stated exclusion.
- Resume rewrites stay grounded: only Aggressive may go past the saved evidence, through ADR 0018's two user-owned relaxations, which choosing Aggressive accepts (ADR 0051). The writer decides what each resume shows and settles lines it cannot back; nothing is approved, queued, or sent without the person's press or their written instruction to the assistant (ADR 0039).

## See also

- product baseline: `docs/PRODUCT.md`
- boundaries: `AGENTS.md`, `docs/ARCHITECTURE.md`
- decisions: `docs/adr/README.md`
