# ADR 0033: The person can finish a prepared application on the kept page, and hand-offs carry on by themselves

Status: accepted (2026-09-24).

## Context

A filled-in application keeps its page in the Job Finder browser with the prepare-only guard installed, so nothing Job Finder does there can send the form. Under Fill in (and for any Ready to send row) the screen told the person to read the form over and click Apply on the site, but the guard cancelled their own press too: the form never went out and nothing said why. Separately, every hand-off on an application page (a sign-in, a CAPTCHA, a missing file) ended with the person pressing "Check whether this step is done", although Job Finder could see on that exact page that the step was done.

## Decision

- Pressing `Open the Job Finder browser` on a filled-in (Ready to send) application opens that exact page to the person: the guard lets their own submit and requests through on that page. It locks again the moment Job Finder works on the page (a continuation or its own send). No other page is opened up, and Job Finder never presses anything while the page is open to the person.
- Sign-in and security-check hand-offs are watched on the exact page kept for the application, identified by a key the tab carries, never by URL or origin. When the wall is gone the same confirmation a person would press is issued automatically, and the normal verifier re-reads that page before the run carries on. Adding or restoring a fitting file in Profile › Files carries a waiting file question on the same way.
- The native host's owner key identifies that tab; the in-page mark is only a runtime copy restored after the exact page attaches. While an application's tab stays live, native ownership follows its durable current attempt. A later attempt continues that same application's still-live earlier page rather than opening a second one. If automation cannot attach, ownership still moves to the current attempt and the exact page stays with the person. A send already pressed prevents that handover and any automatic retry. Verified reconstruction under ADR 0055 applies only when no live owned tab remains.
- Job Finder never acts on a security-check control, including re-ticking one the person already answered.

## Consequences

- Fill in works as described: the person reads the form and presses the site's own send button.
- The "check" press is gone for sign-in and file hand-offs; it remains as a fallback for a CAPTCHA and for other steps.

Rejected alternatives: arming only the observed native form action for the person (misses script and fetch submits, the common case on real sites); matching the kept page by URL (several tabs share an origin, and wizard URLs change).

## Related Decisions

- ADR 0006 (superseded boundary), ADR 0012, ADR 0024, ADR 0027
