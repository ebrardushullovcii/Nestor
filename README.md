# Nestor

A desktop app for job search, in development. Job Finder searches selected job sites in a built-in browser, explains job fit, drafts resumes and fills applications. Electron, React, TypeScript, SQLite and Playwright.

**Status:** Job Finder and Live Assistant are implemented in the repository. This is an active development project; the checks below do not establish release readiness.

## How it works

1. **Profile.** Import a resume in PDF, DOCX, TXT or Markdown and review the extracted profile.
2. **Find jobs.** Add job boards or company careers pages, then inspect the listings and fit explanations.
3. **Resume per job.** Choose Original, Light, Tailored or Aggressive. Review the draft before approving it. Aggressive can add skills from a listing that are absent from the imported profile; review every claim before using an export.
4. **Apply.** Fill forms and attach the resume. Sending modes support confirmation before final submission or automatic submission with saved permission. Filling a form can send details or upload files to the job site before final submission. Saved sign-ins and additional browser permissions are optional.
5. **Track.** Review application progress and items that need your attention.

Live Assistant provides answer and transcript overlays during live interviews, with a hide shortcut and requested screen-capture exclusion. Exclusion across meeting apps has not been verified. Its use depends on the interview's rules and the participants' permission.

## Data and AI

Profile, job, resume and application records are stored locally in SQLite. AI features can send text, browser/tool context and images to the configured provider; audio processing depends on the transcription setup. See [AI provider setup](docs/AI_PROVIDER_SETUP.md) for configuration.

## How it is built

- Electron main and the React renderer communicate through a typed preload bridge.
- Playwright handles browser automation; shared orchestration stays source-generic.
- A pnpm and Turborepo monorepo separates desktop, browser, data and AI packages.
- [Architecture](docs/ARCHITECTURE.md) covers package boundaries and data flow.

## Building from source

Use Node.js 24 and pnpm 10.8.0. Install dependencies, configure a local `.env` using [.env.example](.env.example), and follow [AI provider setup](docs/AI_PROVIDER_SETUP.md) for the AI features.

```bash
pnpm install
pnpm desktop:dev
```

## Checks

- `pnpm verify:quick`: structure and source-generic checks, lint and TypeScript.
- `pnpm test:correctness`: automated correctness tests.
- `packages/ai-evals`: deterministic evaluation cases and separate configured-model benchmarks.
- [CI runs](https://github.com/ebrardushullovcii/Nestor/actions/workflows/ci.yml): Linux static checks and Windows tests. CI does not replace live-model evaluation or packaged-app verification.

[Testing](docs/TESTING.md) maps changes to focused checks and built-app verification. Application tests use synthetic profiles and local replica job sites.

## Documentation

- [Product goals](docs/GOALS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Testing](docs/TESTING.md)
- [Documentation index](docs/README.md)

## Contributing

Start with [AGENTS.md](AGENTS.md) for repository rules. Keep changes focused and use the checks relevant to the affected package.
