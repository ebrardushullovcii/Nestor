# Nestor

Local-first Electron monorepo (pnpm + turbo) with two modules: `Job Finder` and `Live Assistant`. Doc map: `docs/README.md`. Read the ADR in `docs/adr/` before changing behavior it governs.

## Rules

- Never commit, push, or create/update a PR unless the user explicitly asks. A requested commit is pushed in the same step; if the current branch was already merged, use a new branch off `origin/main`.
- Don't run a release-acceptance chain unless the user declares a release candidate. `docs/TESTING.md` maps changes to automated checks.
- Never kill a process you did not start. No `pkill -f electron`, `pkill -f Nestor` or `killall Electron`: they hit the user's own `pnpm desktop:dev`. Stop only what you launched, through its handle or PID tree.
- Test runs send applications only to the local replica job sites (`docs/TESTING.md`); anywhere else they stay `prepare_only` with `submitAuthorized: false`. Final submission, account creation, credentials, CAPTCHA and MFA stay the person's unless they authorize the step (ADR 0012, 0024, 0027).
- Never put personal resumes, credentials or authenticated browser state in fixtures, prompts, docs or evidence.
- Preserve the user's dirty worktree: never reset, clean, revert, stash or delete their changes, and don't restore files another session deleted.
- Durable knowledge goes in `docs/` and `docs/adr/`; no status logs, handoff notes, evidence logs or plan files in the repo. Edit docs only when asked or when your change makes one wrong. Write an ADR only when asked.

## Boundaries

Package ownership and data flow: `docs/ARCHITECTURE.md`.

- Renderer talks to Electron main only through the typed preload bridge; never expose raw Node or Electron primitives to it.
- Shared types, schemas, DTOs and IPC payloads come from `packages/contracts`. No `any`, no untyped IPC, no deep cross-package imports.
- Discovery, source-debug and apply preparation stay source-generic: no per-board route builders, query maps, triage overrides or policy branches in shared orchestration (ADR 0007; `pnpm source-generic:check`). Reusable provider adapters are fine.
- `packages/browser-agent` owns browser workflow policy, prompts and structured outputs; `packages/browser-runtime` stays generic. Renderer and Electron layers don't depend on browser-agent internals.
- `packages/agent-runtime` is product-neutral: no domain schemas, writes go to reversible drafts, it never executes external actions, and persisted typed state is the memory, not the model conversation.
- Persistence stays behind repository interfaces in `packages/db`; no SQL or storage details reach the renderer.
- Native code lives behind `packages/os-integration`, and only when Electron APIs are insufficient.

## Checking the app

Use the `verify-nestor` skill to drive the built app like a user: its own isolated instance with temporary data and synthetic profiles, never the user's `pnpm desktop:dev`. Details: `docs/TESTING.md`.

## Website

`apps/website/` is the live landing page; Netlify deploys it when a merge to `main` changes that folder. Never deploy it from local files. Videos and other designs live in `../nestor-marketing` (see its `AGENTS.md`).
