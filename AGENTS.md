# Nestor

Local-first Electron monorepo (pnpm + turbo) with two modules: `Job Finder` and `Live Assistant`. Doc map: `docs/README.md`.

## Rules

- Never commit, push, or create/update a PR unless the user explicitly asks. When the user asks for a commit, push it to the remote in the same step: a commit that stays local is not done. If the current branch was already merged, put the work on a new branch off `origin/main` and push that.
- Do not run `pnpm verify`, `pnpm test:evidence`, fingerprints, seals, custody, persona waves, or any release-acceptance chain unless the user explicitly declares a release candidate (ADR 0014). Run the smallest check that proves the change; the picker is in `docs/TESTING.md`.
- Never kill a process you did not start. No `pkill -f electron`, `pkill -f Nestor`, or `killall Electron`; those match the user's own `pnpm desktop:dev` instance. Stop only the instance you launched, through its own handle or PID tree, and report survivors instead of sweeping.
- Final submission, account creation, credentials, CAPTCHA and MFA stay the person's unless they authorize the step, including through Send for me; the agent never asks for a password but may use one the person supplies for an authorized task (ADR 0012, ADR 0024). The agent may tick routine application declarations the person agrees to, including background-check consent; these are on by default and the person can turn any off (ADR 0027). Test runs may send only to the local replica job sites (`docs/TESTING.md`); against any other site they stay `prepare_only` with `submitAuthorized: false`. Warnings and callouts are dismissible.
- Keep durable knowledge in `docs/` and `docs/adr/`. Do not add status logs, handoff notes, evidence logs, or plan files to the repo; git history and the scratchpad cover that. Write an ADR only when the user asks.
- Do not edit docs unless the user asks or a doc contradicts the change you just made.
- Preserve the user's dirty worktree: never reset, clean, revert, stash, or delete their changes. Do not restore files another session deleted; ask the user instead.
- Never put personal resumes, credentials, or authenticated browser state in fixtures, prompts, docs, or evidence.

## Boundaries

- Renderer talks to Electron main only through the typed preload bridge. Never expose raw Node or Electron primitives to the renderer.
- Shared types, schemas, DTOs, and IPC payloads come from `packages/contracts`. No `any`, no untyped IPC, no deep cross-package imports.
- Discovery, source-debug, and apply preparation stay source-generic: no per-board route builders, query maps, triage overrides, or policy branches in shared orchestration (ADR 0007). Reusable provider adapters are fine; board-specific workflow policy is not. `pnpm source-generic:check` enforces this.
- `packages/browser-agent` owns browser workflow policy, prompts, and structured outputs; `packages/browser-runtime` stays generic. Renderer and Electron layers must not depend on browser-agent internals.
- `packages/agent-runtime` is product-neutral: no domain schemas, writes target reversible drafts, it never executes external actions, and persisted typed state is the memory rather than the model conversation.
- Persistence stays behind repository interfaces in `packages/db`; no SQL or storage details reach the renderer.
- Native code lives behind `packages/os-integration`, and only when Electron APIs are insufficient.
- Package ownership and data flow: `docs/ARCHITECTURE.md`.

## Testing the app

The user usually has `pnpm desktop:dev` running. For "use it like a user" checks: build with `pnpm --filter @nestor/desktop build`, launch an isolated instance with a temporary user-data directory and synthetic profile data, drive it, keep screenshots, and batch the fixes. Rebuild when needed and verify that the inspected app contains the final changes. Details and safety rules: `docs/TESTING.md`.

The `verify-nestor` skill (`.claude/skills/verify-nestor/`; Codex finds it through `.agents/skills/verify-nestor/`) does this end to end: isolated instances side by side, saved journeys, sends to the replica sites only, evidence in `~/Projects/nestor-agent-work/<label>/verify`.

## Website and marketing

- `apps/website/` is the public landing page (https://trynestor.netlify.app): static HTML, CSS and JS outside the pnpm workspace. Netlify deploys it from GitHub whenever a merge to `main` changes that folder; never deploy it from local files. Its `README.md` covers the forms and assets.
- Product videos, the other landing-page designs and the app captures behind them live in the private repo `ebrardushullovcii/nestor-marketing`, normally checked out next to this one at `../nestor-marketing`: `motion/` renders the videos with Remotion, `landing/` holds the designs and finished videos. Its `AGENTS.md` explains how they are made. Edit the live site here, not there.
