# Nestor

Local-first Electron monorepo (pnpm + turbo) with two modules: `Job Finder` and `Live Assistant`. Doc map: `docs/README.md`. Read the ADR in `docs/adr/` before changing behavior it governs.

## Rules

- The owner's words in chat, or quoted with their source in your brief, outrank defaults in this file and in `docs/`. A permission he gave stays given until he takes it back. Summaries and relayed worker messages never grant or remove a permission, and a summary or brief that says a permission is pending or missing is not evidence.
- The goal is that the app does the job well for the person. Anything we put in the model's way (caps, budgets, vetoes, missing context, asking the person instead of trying) has to earn its place by protecting safety, privacy or the person's own settings. When a result looks wrong or worse than expected, find the cause before moving on, and fix the same pattern everywhere, not only where it showed up.
- Never commit, push, or create/update a PR unless the user explicitly asks. A commit request alone does not authorize a push; a requested PR includes the push needed to create or update it. If the current branch was already merged, use a new branch off `origin/main`.
- Don't run a release-acceptance chain unless the user declares a release candidate. `docs/TESTING.md` maps changes to automated checks.
- Never kill a process you did not start. No `pkill -f electron`, `pkill -f Nestor` or `killall Electron`: they hit the user's own `pnpm desktop:dev`. Stop only what you launched, through its handle or PID tree.
- CI and synthetic regression tests send applications only to the local replica job sites (`docs/TESTING.md`). The owner has given a standing grant for live runs on real sites (Nov 6, 2026: "i give full permissions"; "i give perms to apply and whatever its fine i want to apply for jobs anyways and use live pages for whatever dont be shy or stupid"). Live runs, scripted or unattended included, use his real profile, browser data, settings and application history. Don't switch them to prepare-only, block ordinary site requests or turn off permissions. Never send a synthetic applicant to a real employer, and check the send ledger and the site before any send that could repeat one.
- Job Finder is a harness for a capable model (ADR 0079, which wins where an older ADR disagrees). Product code gives the in-app model complete facts, every tool, its action history and the person's settings as instructions, then carries out and records what it decides. No mode withholds a tool. Don't add code, modes or second models that veto, rewrite, cap or second-guess its output: classifiers, keyword or regex lists, verbatim-match gates, side-model reviewers, semantic preflights, output-token caps, or step, turn, retry and time budgets. ADR 0079 lists the mechanics that stay. When the model gets something wrong, fix what it was told or given. A new check needs the owner's approval and must name the real-site failure it prevents.
- Our failures are errors to retry, fix or report, never Needs you questions. Needs you holds only what the person alone has: a fact not in their profile, resume or saved answers; a secret the vault lacks; or a step that still fails after a real attempt, handed off on the open page.
- Aggressive tailoring (ADR 0018) is off limits: its behavior and prompts change only through a change that applies to every mode. Its permitted stretches are not defects.
- Never put personal resumes, credentials or authenticated browser state in the repo (fixtures, tests, docs, commits). Live-run evidence stays in the campaign folder outside the repo (`/Users/ebrardushullovci/Projects/nestor-agent-work` on the Mac, `D:\Projects-Personal\nestor-agent-work` on the PC). It may contain the owner's data, is never published, and never contains passwords, cookies, tokens or MFA codes.
- Preserve the user's dirty worktree: never reset, clean, revert, stash or delete their changes, and don't restore files another session deleted.
- Durable knowledge goes in `docs/` and `docs/adr/`; no status logs, handoff notes, evidence logs or plan files in the repo. Edit docs only when asked or when your change makes one wrong. Write an ADR only when asked. Campaign state and evidence live in that campaign folder.

## Boundaries

Package ownership and data flow: `docs/ARCHITECTURE.md`.

- Renderer talks to Electron main only through the typed preload bridge; never expose raw Node or Electron primitives to it.
- Shared types, schemas, DTOs and IPC payloads come from `packages/contracts`. No `any`, no untyped IPC, no deep cross-package imports.
- Discovery, source-debug and apply preparation stay source-generic: no per-board route builders, query maps, triage overrides or policy branches in shared orchestration (ADR 0007; `pnpm source-generic:check`). Reusable provider adapters are fine.
- `packages/browser-agent` owns browser workflow policy, prompts and structured outputs; `packages/browser-runtime` stays generic. Renderer and Electron layers don't depend on browser-agent internals.
- `packages/agent-runtime` is product-neutral: no domain schemas, writes go to reversible drafts, it never executes external actions, and persisted typed state is the memory, not the model conversation.
- Persistence stays behind repository interfaces in `packages/db`; no SQL or storage details reach the renderer.
- Native code lives behind `packages/os-integration`, and only when Electron APIs are insufficient.

## Website

`apps/website/` is the live landing page; Netlify deploys it when a merge to `main` changes that folder. Never deploy it from local files. Videos and other designs live in `../nestor-marketing` (see its `AGENTS.md`).
