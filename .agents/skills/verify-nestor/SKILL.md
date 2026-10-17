---
name: verify-nestor
description: Drive the real Nestor desktop app (Electron) and the public website the way a person would, and keep proof. Covers Job Finder (resume import, job sources, search and fit, shortlist, tailored resume, apply and send to the local replica job sites only) and Live Assistant (setup and a session), each run in its own isolated instance with a private data folder, its own ports and synthetic data. Use it to prove a change works in the app, reproduce a bug on a screen, or collect screenshots, step logs and the SQLite rows an action wrote. Safe beside the owner's own `pnpm desktop:dev` and other agents' instances.
---

# verify-nestor

The skill lives in `.claude/skills/verify-nestor/`, shared by Claude Code and Codex. Read `.claude/skills/verify-nestor/SKILL.md` in full and follow it. Its helpers are in `.claude/skills/verify-nestor/bin/`, its saved journeys in `.claude/skills/verify-nestor/journeys/` and its feature map in `.claude/skills/verify-nestor/features/`.
