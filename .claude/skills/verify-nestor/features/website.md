# Website

The public landing page at https://trynestor.netlify.app, built from `apps/website` (static HTML, CSS and JS; Netlify deploys it from `main`). A visitor reads the product story, watches the tour video, and leaves an email in either "Get early access" form (Netlify Forms, `early-access`).

## Sub-features

- `web-hero`: h1 "A calmer way to look for work.", hero signup form.
- `web-sections`: How it works, Fit, Applying, Privacy, Questions (nav links), Live Assistant section, FAQ.
- `web-signup`: two forms `form[data-signup]` (hero and footer, "Search with good counsel."), email field "Email address", "Get early access", status text "Thank you. We will email you when you can try Nestor."
- `web-tour`: link `[data-tour]` opens the dialog "The Nestor tour" with `assets/video/product-tour.mp4`.
- `web-responsive`: phone width without sideways scroll.

## How to get to it (user POV)

- Open the site; everything is one page.

## Driving it with verify-nestor

Preconditions: none (no app instance). `bin/website` serves this checkout's `apps/website` on a free loopback port and drives it in headless Chromium.

- **Screens.** `$V/website shot / home`, `$V/website shot / home-phone --width 390 --height 844 --full`.
- **Signup.** Fill `form[data-signup]` "Email address" with an `@example.test` address and press "Get early access". Proof: the status text, and one line in `website-posts.jsonl` with `form-name: early-access` and the email. The post goes to the local server, never Netlify.
- **Tour.** Click `[data-tour]`; shot of the dialog.
- Whole flow: `$V/website run .claude/skills/verify-nestor/journeys/website.mjs` (desktop and phone, about 3 s).
- The deployed site is out of scope: never submit its forms. To check a deploy, compare a read-only `curl` of https://trynestor.netlify.app with the local files.

## Gotchas

- Every request outside the local server is refused except Google Fonts GETs; the helper prints what it blocked.
- The tour video still shows the old NORDRI wordmark (re-rendering was deferred at the Nestor rename, ADR 0052). Not a regression.
- The forms post with `fetch("/")`; locally the helper answers 200, so success copy shows even though Netlify never saw it.
