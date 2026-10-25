# ADR 0021: Apply agent runtime

Status: accepted

## Context

Applications were prepared by a fixed script: eight passes over the page, deterministic inspection, and a stop. It could only finish a form whose shape it already anticipated, it spent passes on short forms and ran out on long ones, and every new kind of page meant new code. ADR 0012 authorised full application automation behind an explicit authority document, and ADR 0013 set the shape: observe, propose, authorise, execute, verify. Discovery already works this way — the agent is told the goal and decides when it is done, a stall gets one warning before the run ends, and it can stop itself by saying it is stuck.

## Decision

Applying for a job is done by a harness, not by a script with an agent bolted on. The agent gets the ordinary powers a person has in a browser and is trusted to work out how a particular site wants to be used.

It can look at the whole page, read it in full, click anything, follow a link, go to an address, type, choose, tick, upload, scroll, wait, and go back. Nothing it observes is filtered: every visible control, every button, every link with its address and its text, every other clickable thing, the headings, the tabs the page opened, and an excerpt of the text all reach it with a stable handle. A page that shows an Apply button shows it, whatever that button is made of and whatever it is called.

The run starts wherever the job link points — a listing, a board, an aggregator, a form — with one goal: reach the application form for this job and fill it completely from the person's profile and resume. If the site sends it somewhere else, it follows. Cookie banners and chat overlays are things to close, not reasons to stop. A wrong turn is something to come back from. It stops when the form is done, when only the person can go further, or when it is genuinely stuck, and it says which in its own words — the person reads exactly what it wrote.

Deterministic code is kept only where it is about safety, and it is deliberately small:

- an answer about the person comes from their own profile, resume and saved answers, never from the model's memory of them; the agent is given those facts and every answer is checked against them before it is entered (ADR 0041)
- a declaration the person makes about themselves is only made when they approved that exact kind in advance
- a write proposed against a page that has moved on is retried against the page as it is, rather than landing in the wrong field
- the person never has an account created, credentials entered, or a security challenge worked around
- sending an application goes through its own preflight, the saved authority, and one idempotency key
- origins the person named are enforced; a hop to a site they did not name is reported to the agent as a fact and allowed, because a listing on one site whose form lives on another is the ordinary shape of job applications

Stall handling is warn-then-stop with a generous window — twelve steps that fill nothing in, because reading, scrolling, closing a banner and trying a link are all reasonable. There are no step quotas, only safety ceilings: two hundred steps and fifteen minutes.

### What was removed, and why

- **`resolveApplyEntry` / `findApplyEntry` and the pre-loop gate.** They decided, before the agent was consulted, whether a page was already a form and which link was the way in. On a board listing carrying a search box and an AI chat input they concluded the page *was* the form and reported "no application form or apply button" while a person could see the Apply button plainly. The same code refused `target="_blank"` links as a hand-off, which is how a large share of boards link to the employer's form.
- **The deterministic pre-fill pass.** Filling every field the sources answered before the agent had looked made the agent's picture of the page wrong from the first turn, and made the run unable to explain what it had done.
- **Phrase lists in the observation.** Deciding what counted as an action, an apply link, or a form control by matching words is what made the harness blind to buttons a person could see.

Nothing above changes the discovery and source-check loops, which already work this way.

## Consequences

The loop is source-generic and the same code reads a single-page form, a form split over several screens, and an in-page modal. Form families are proved by fixtures rather than by branches.

Job Finder owns the seam (`packages/job-finder/src/internal/agent-application-preparation.ts`): it installs the prepare-only guard, runs the loop, and turns the result into the application record. Playwright's `Page` does not cross that boundary — whoever owns the browser builds the page hands.

The fixed eight-pass script is gone. `packages/browser-runtime/src/playwright-application-flow.ts` keeps only what is still a browser mechanic — the prepare-only mutation guard, the service-worker sentinel, resume byte verification, and the result builder — and shrank from about 5900 lines to about 1900. Its form inspection, grounded-answer resolution, blocker detection and fill routines were replaced by the agent path; the phone-country handling moved up into answer sourcing, where deciding which country a number belongs to is a decision rather than a mechanic.

The runtime no longer decides how a form is filled. `executeApplicationFlow` opens the page, watches for service workers, and hands the caller one open page's worth of bounded operations through `ApplyPageSession`; `prepareApplicationForm` is a required part of its input, so a run that has no preparer cannot start. Job Finder supplies that preparer for every mode. A build with no model available stops the application and says so as an outage, because the model is part of the product rather than something the person configures.
