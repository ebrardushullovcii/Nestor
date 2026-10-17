# Job Finder Profile References

Use this directory for profile-screen visual references only. The Job Finder profile captures candidate preferences and reusable application material; see `docs/PRODUCT.md` and `docs/ARCHITECTURE.md` for the durable product and architecture baseline.

## Retention Policy

- Keep active reference material small and easy to scan.
- Consolidate superseded baseline metadata into this README when a separate historical note no longer needs to stay as its own file.
- Keep a historical baseline only when it still helps screenshot comparison or regression review.
- Delete stale artifacts when they no longer help active design or regression work.

## Historical Baselines

### 2026-03-23 Profile Shell Baseline

- context: captured during `codex/profile-resume-polish` before later setup, resume, and profile work changed the active profile shell baseline
- branch at capture time: `codex/profile-resume-polish`
- artifact availability: no committed artifact folder is retained for this historical snapshot; use fresh harness output when you need a current comparison
- viewport: `1440x920`
- rerun command: `pnpm --filter @nestor/desktop ui:profile-baseline`
- note: this entry is retained as historical metadata only; generated UI artifacts are disposable and should be recreated as needed rather than stored here long-term
