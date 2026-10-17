# Apply and send

"Apply" approves the resume and starts the application: Job Finder opens the job's application page in its in-app browser, fills the form from the profile, attaches the resume, and then follows the application mode in Settings. Under "Ask before sending" (the default) it stops before the site's send button and the person reads it over and sends it themselves; under "Send for me" Job Finder presses send. Applications tracks every application and its stage. Final submission stays the person's unless they authorize it (ADR 0012, 0024, 0027).

## Sub-features

- `apply-start`: "Apply" on a ready Shortlisted job; lands on Applications with "Job Finder is filling in the form".
- `apply-ready`: "Ready to send", "Ready for you to read over and send", the region "Review before sending" listing every answer going out and where it came from.
- `apply-browser`: "Open the Job Finder browser" / "Reopen the Job Finder browser"; the browser peek modal over the app.
- `apply-person-send`: the person presses the site's own Submit; the app records "You sent this application yourself on the site." and "Submitted (verified)" with the site's receipt.
- `apply-send-for-me`: Settings application mode "Send for me" (typed consent); Job Finder presses send itself.
- `apply-documents`: "Draft a cover letter" / short response document for an attachment question.
- `applications-tracking`: filters (All, Waiting on you, In progress), "Hiring stage", "Open tracker", "Prepare interview" (links to Live Assistant).
- `apply-recovery`: "Could not apply" and recovery actions.

## How to get to it (user POV)

- Shortlisted › job › "Apply".
- Sidebar › Applications.
- Settings › application mode for Send for me.

## Driving it with verify-nestor

Preconditions: a ready resume on `up --ai live`; the job comes from this instance's replica sites. Never apply to anything else.

- **Prepare.** `$V/drive click Apply --role button`, `$V/drive wait "Ready for you to read over and send" 900 --role heading`. Measured: 20 s on `/board/`. Proof: shot, the "Review before sending" region in `see`, `$V/db application_records 1` with status `ready_for_review` and no replica receipt yet.
- **Send it yourself.** `$V/drive click "Open the Job Finder browser"`; `$V/drive shot form --target browser --url /apply/`; check the page's origin is the instance's replica (`sites.url`); `$V/drive click Submit --page browser --url /apply/`; `$V/drive wait "Thank you! Your application has been received." 30 --page browser --url /apply/`; `$V/drive press Escape`; `$V/drive wait "Application submitted" 60`. Proof: one new line in `submissions.jsonl` with the fields and the tailored PDF's name, and `$V/db application_records 1` with `status: "submitted"` and `personSendReceipt`.
- Whole flow: `journeys/job-finder-replica.mjs apply`, then `send`. The journey refuses to press Submit unless the page's origin is the instance's replica server.
- **Other forms.** Point the source at `/lever/` (CAPTCHA, background-check consent), `/greenhouse/` (drop zone, EEO), `/workday/` (account wall, four steps), `/gatekeeper/` (overlay, interstitial, new tab) or the larger sites. Not run through this skill yet.
- **Send for me.** Not run through this skill yet. Settings › application mode › "Send for me" with its typed consent, then Apply; the proof is a replica receipt with no person click, and `application_authority_envelopes` naming the replica origin.

## Gotchas

- The browser peek is modal: press Escape before clicking the app again.
- A restart or `down` while an application is "Ready to send" loses the prepared page; it becomes "Could not apply". Send first.
- `drive shot --target browser` captures the page itself; app chrome never paints above a WebContentsView, so a main-window shot shows the app without the page.
- The send guard blocks the app from posting to any non-loopback host. If a real site appears in `blocked-requests.jsonl`, something tried to leave the replica: report it.
- Replica Workday accounts and saved steps live in the replica server's memory and vanish on `down`.
