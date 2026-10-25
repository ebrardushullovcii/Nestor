# ADR 0015: Minimal agent guidance

Status: accepted (2026-09-04).

## Context

An earlier decision introduced a canonical documentation system: a registry, generated `CLAUDE.md` and Cursor adapters, fifteen package-level `AGENTS.md` files, `STATUS.md`/`TRACKS.md` as a handoff layer, exec plans, a history file, and a validator that enforced all of it. Session logs from Codex and Claude Code showed the cost: `STATUS.md` grew from 86 to 2,419 lines in four months of agent-written summaries, about 28 percent of edits in long sessions went to docs, the generated `CLAUDE.md` used `@` imports that injected roughly 455 KB into every Claude Code session, and the status docs steered agents into work the user had not asked for. Package guides, the registry, the adapters, and vendored library skills were read ritually and rarely changed an outcome.

## Decision

- One root `AGENTS.md` (read by Codex and, through a one-line `@AGENTS.md` import in `CLAUDE.md`, by Claude Code) holds the behavioral rules and package boundaries. It stays short.
- Durable knowledge lives in `docs/` (goals, product, architecture, contracts, testing) and `docs/adr/`. Nothing in the repo tracks current status or handoff state.
- No generated adapters, registry, validator, package-level `AGENTS.md`, exec plans, history file, or vendored library skills. Modern models know Electron, Zod, Vitest, and similar libraries; repo docs record only what is specific to this product.
- Docs change only when the user asks or when a change makes a doc wrong.
- An agent that finds these files missing must not recreate them from memory, file history, or a generator; their absence is this decision.

## Consequences

- `pnpm validate:docs-only`, `agents:sync`, `agents:check`, and `docs:check` are removed.
- Agents that need current state read git history and the code.
