# Local replica job sites

From the repo root, run `node apps/desktop/test-fixtures/job-sites/serve.mjs` with Node 22 or newer. Open `http://127.0.0.1:47950/` for the index. Set `PORT=0` for a free port (printed at startup), or choose an explicit free port. Each listing URL can be added as a Job Finder source. The original five sites each have ten fictional software jobs; the fifteen new sites add 1,234 listings across ten fields.

`http://127.0.0.1:47950/board/` exercises age badges, job details, a handoff to `/employer-a/apply/<id>`, a hidden resume input, cover letter and required certification.

`http://127.0.0.1:47950/lever/` exercises location selection and autocomplete, an opacity-zero resume input, background-check consent and a fake CAPTCHA with an inline error.

`http://127.0.0.1:47950/greenhouse/` exercises resume attachments and a drop zone, optional cover-letter upload, custom questions, radio buttons and optional EEO selects.

`http://127.0.0.1:47950/workday/` exercises application choices, account creation and sign-in, four steps, repeatable work experience, a simulated autofill spinner, review and required terms. Use made-up credentials; accounts and saved steps live only in server memory. Restarting clears them. Saved steps do not restore after a page reload.

`http://127.0.0.1:47950/gatekeeper/` exercises a cookie overlay, chat bubble, eight-second security interstitial, new-tab apply form, per-field fetch autosaves and a fetch submission that confirms receipt without navigation.

`http://127.0.0.1:47950/fill-chores/apply/1` is one form with the chores around it: a cookie banner (Accept all or Reject all), an "Apply for this job" button that reveals the form, a region list loaded with a GET for the chosen country beside a GET autosave of that choice, and work history rows added with "Add another position".

`http://127.0.0.1:47950/steps-shape/jobs/1` is a two-step application in Workday's shape: the listing's "Apply" opens the form, a step list marks the current step, and "Save and Continue" keeps the step as the site's own draft before the next shows (coming back to a saved step shows what was saved). Only the last step's Submit sends it.

`http://127.0.0.1:47950/atlas/` has 300 jobs and exercises page numbers, query filters, sorting, duplicate jobs, sponsored cards and discovery decoys.

`http://127.0.0.1:47950/ripple/` has 300 jobs and exercises load more, query filters, duplicate jobs, initials-only companies and a local ATS redirect.

`http://127.0.0.1:47950/brindle/` has 120 jobs and exercises department filters, four steps, resume prefill and repeatable work and education.

`http://127.0.0.1:47950/folio/` has 36 jobs and exercises portfolio URLs, a required cover-letter upload and a limited rich text answer.

`http://127.0.0.1:47950/harbor-health/` has 48 jobs and exercises five steps, phone codes, availability dates, skill experience and voluntary diversity.

`http://127.0.0.1:47950/lessonloom/` has 42 jobs and exercises three steps, upload or paste a resume, education rows and teaching motivation.

`http://127.0.0.1:47950/parcelpath/` has 60 jobs and exercises four steps, searchable country picker, phone codes, dates and salary currency.

`http://127.0.0.1:47950/clientnest/` has 45 jobs and exercises single page, searchable comboboxes, yes/no questions and multiple skill checkboxes.

`http://127.0.0.1:47950/ledgerleaf/` has 40 jobs and exercises six steps, work history, salary expectations, notice period and review.

`http://127.0.0.1:47950/marketmoss/` has 50 jobs and exercises resume text alternative, validated URLs and a rich answer with a character counter.

`http://127.0.0.1:47950/peoplepetal/` has 36 jobs and exercises three steps, voluntary EEO answers, declarations and an unticked marketing option.

`http://127.0.0.1:47950/cedar-ats/` has 55 jobs and exercises local ATS handoff, guest/account choice, resume prefill and session timeout recovery.

`http://127.0.0.1:47950/framehire/` has 30 jobs and exercises same-origin application iframe with inline validation and receipt.

`http://127.0.0.1:47950/slowgrove/` has 28 jobs and exercises three-to-eight-second page responses and a three-step application.

`http://127.0.0.1:47950/pacer/` has 44 jobs and exercises short HTTP 429 cooldown with Retry-After and a single-page application.

Run `node apps/desktop/test-fixtures/job-sites/check.mjs` for the dependency-free HTTP self-check. It starts and stops its own server on a random port, visits every original job and application, walks every new listing page, opens representative details and forms, and submits one synthetic application per site. It also checks account/CAPTCHA gates, query filters, duplicates, closed jobs, email-only applications, local ATS redirects, inline validation, delayed responses, rate-limit recovery and POST logging. It checks iframe and wizard markup but does not execute browser JavaScript.

Every parsed POST writes one JSON line to stdout and the gitignored `submissions.log` beside the server. Passwords are redacted; uploads log filename, type and size, not file contents. Startup messages go to stderr. All pages and assets are local, and successful applications display “Thank you! Your application has been received.” Use only synthetic data. Job Finder agent runs may send real applications to these fixtures, and only to them; the self-check also submits directly.

The new sites use a fixed seed. Job identities and attributes stay the same across restarts; posting dates are relative to the server's UTC startup day, spanning today through 90 days ago. Some German locations have German listings. The two large boards share requisition `SHARED-ACORN-0001`; these are 1,234 listings, not 1,234 distinct vacancies. Each new site paginates in batches of 20.

Use `/atlas/?q=designer&location=remote&sort=newest&page=2` or `/ripple/?q=designer&location=remote&sort=oldest&offset=20` as filtered sources. Sort values are `newest`, `oldest`, `title` and `salary`. `/brindle/?department=Healthcare` exercises a company department filter. Every new site also links to category, company, blog and salary-guide pages that are not vacancies. Odd-numbered details have JSON-LD; even-numbered details do not. Job 30 is closed where present. `/folio/jobs/2` is email-only; never send email. `/ripple/apply/3` redirects to `/cedar-ats/apply/3` on the same server.

Resume parsing is simulated: a TXT resume may contain `Name:`, `Email:` and `Phone:` lines; other formats fill fictional fallback contact details. It only fills blank fields. Review the result. Work and education entries are optional; added rows must be completed or removed. Professional-profile and code-profile URL fields stand in for familiar profile services without using their branding. Marketing is optional and starts unticked. Country search supports typing, list selection and arrow/Enter keys.

The local ATS offers guest applications and an optional synthetic profile. Its warning appears after 60 seconds and the form times out after 120 seconds; Keep working preserves answers and restarts the timer. `/slowgrove/` and application pages wait three seconds; detail pages wait five seconds, except job 2 which waits eight. `/pacer/` allows eight requests in three seconds, then returns HTTP 429 with `Retry-After` for a two-second cooldown. Requests rejected by the limiter do not reach the POST parser or submission log.

New modules live in `sites/`; the original site assets and routes remain separate. `check-more.mjs` is called by `check.mjs` and uses the same owned server and temporary log. No dependencies, external resources or internet requests are needed.

## Large source set

`/__scale__/manifest` generates 900 source URLs across `127.0.0.1` through `127.0.0.12` on this server's port. The additional listeners start only when the manifest is requested and close with the server. The catalog contains 4,320 distinct fictional jobs, including 180 senior backend jobs in the US and 60 entry-level part-time analyst jobs in Berlin; `expected.dev` and `expected.lina` enumerate their canonical URLs.

There are 540 employer boards, 270 overlapping aggregators, 30 empty boards, 12 script-rendered boards, 18 sign-in gates, 12 verification gates, 10 first-request rate limits and 8 slow boards. Lists use JSON-LD, plain list items or articles, with observed next-page links. Gates have a local-only Continue with synthetic session button; no credentials are needed. `GET /__scale__/metrics` reports request/detail/browser/gate counts and peak requests per hostname. `POST /__scale__/reset` resets counters and first-request rate limits, without signing out browser sessions.

This tests generic HTML and structured-data collection, queues, duplicates, access and repeat behavior. It does not emulate the public APIs of every supported ATS provider.
