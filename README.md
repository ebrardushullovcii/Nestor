<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/in-app/wordmark-on-dark.svg">
  <img src="assets/brand/in-app/wordmark.svg" alt="Nestor" width="240">
</picture>

# Nestor

A local-first desktop app for job search, in development. Job Finder searches the job sites you choose in its own browser, shows how well each job fits you and why, writes a tailored resume for each job you shortlist, and fills in the applications. You decide what gets sent, and your profile, jobs, resumes and applications stay on your computer.

**[Website and 38-second tour](https://trynestor.netlify.app)**

## How it works

1. **Profile.** Import a resume (PDF, DOCX, TXT or Markdown). Nestor builds your profile and asks only about what is missing.
2. **Find jobs.** Add job boards or company careers pages. Nestor searches them in its built-in browser and reads every listing.
3. **Fit.** Every job gets a fit score, with the evidence behind it and what is still unknown.
4. **Resume per job.** Pick how much each resume is tailored, then review, edit and approve it.
5. **Apply.** Nestor opens the application, fills it in and attaches the resume. Sign-in, security checks and account creation always pause for you, and nothing is sent unless you allow it.
6. **Track.** See where each application stands and what it needs from you.

A second module, Live Assistant, is an interview companion.

## How it is built

- Electron, React and TypeScript in a pnpm and Turborepo monorepo, with apps in `apps/` and packages in `packages/`.
- The renderer talks to the Electron main process only through a typed preload bridge.
- Browser automation runs on Playwright and stays source-generic: no per-site route builders ([ADR 0007](docs/adr/0007-source-generic-browser-workflows.md)).
- Local data is stored in SQLite (`node:sqlite`).
- AI behaviour is checked by evaluation cases in `packages/ai-evals`.
- Decisions are recorded as ADRs in [docs/adr](docs/adr/README.md).

## Working on the repo

- Repo contract: [AGENTS.md](AGENTS.md)
- Docs map: [docs/README.md](docs/README.md)
- Durable goals: [docs/GOALS.md](docs/GOALS.md)
- Decisions: [docs/adr/README.md](docs/adr/README.md)
- UI design references: [docs/Design/README.md](docs/Design/README.md)

Pull in architecture, contract, and testing docs only when the task needs them.

```bash
pnpm install
pnpm format:check
pnpm verify:quick
pnpm lsp:typescript
pnpm knip
pnpm desktop:dev
```
