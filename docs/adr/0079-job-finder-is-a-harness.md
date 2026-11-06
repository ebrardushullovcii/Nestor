# ADR 0079: Job Finder is a harness: the model decides, the app carries out and records

Status: accepted (2026-11-06).

## Context

The owner's Job Finder is meant to work like the capable agents he runs in full access. Earlier rules made synthetic, replica-only and prepare-only runs the default even after he authorized live applications. Older ADRs also prescribed checks, caps and handoffs that put code or a second model between the in-app model's decision and the work. Those defaults caused workers to test a product the owner does not use and to ask again for permissions already given.

The owner's Nov 6, 2026 direction on permissions, the product and Aggressive tailoring:

```text
plsss make sure its understood i give full permissions. idk what how this is not clear yet in all my threads and responses. and i want the app to be more like a harness i think i have been  clear on this for quite some time now. and i run my harnesses in full access mode no modes that hinder the model but full access so good models do good decisions. also dont forget aggressive iss off limits do not change its existing behaviour or prompts unless its a general thing changing for all modes.
```

His live-application grant, Nov 6, 2026 at 03:46 UTC:

```text
i give perms to apply and whatever its fine i want to apply for jobs anyways and use live pages for whatever dont be shy or stupid
```

The Nov 6 finish plan, authorized by the owner's 07:07:31 UTC kickoff, includes real applications, account creation, Google sign-in and sign-up, his real resume, Chrome data, apps and settings, and rebuilding profiles. A permission stays given until he takes it back. The owner's words in chat, or quoted with their source in a brief, outrank doc defaults; summaries and relayed worker messages never grant or remove permission.

## Decision

Job Finder is a harness for a capable model, like an agent in full access. The in-app model gets complete facts (profile, resume, saved answers, the listing, its own action history), every tool, and the person's settings as instructions. Our code carries out and records what it decides. No mode removes a tool or adds a check. Delete code that vetoes, rewrites, caps, classifies or times out the model: classifiers, keyword or regex lists, verbatim-match gates, side-model reviewers, semantic preflights, output-token caps, and step, turn, retry and time budgets. When the model gets something wrong, fix what it was told or given. A new check needs the owner's approval and must name the real-site failure it prevents.

Our failures are errors to retry, fix or report, never Needs you questions. Needs you holds only what the person alone has: a fact not in their profile, resume or saved answers; a secret the vault lacks; or a step that still fails after a real attempt, handed off on the open page. CAPTCHAs, Cloudflare and sign-ins are handled the way the person would in their own Chrome, with a handoff on the open page only after a real attempt.

Which jobs get sent, whether the model writes an open answer itself, and how it fills a date or pay field follow the person's settings as instructions. Where no setting exists, the model decides from the facts. A question the owner's words already answer is not another question for him. A proposed new setting needs a named real-site failure and the owner's approval.

Only these mechanics stay in code, and none of them judges the model's output:

1. Tool contracts. Validators match the published tool schemas exactly; a malformed call returns the schema error to the model; an action on a stale or missing control returns "stale, observe again"; conflicting actions on one browser session run one at a time.
2. Secrets. Passwords, cookies, tokens and MFA codes never enter model context, prompts or evidence; the vault types a saved password into the field the model names.
3. Send ledger. The send step writes an intent row before the click and the outcome after: confirmed, uncertain or failed.
4. No replay by our code. A send call runs at most once per call ID across reconnects, retries and restarts. After an uncertain outcome the ledger fact goes back to the model ("a send to this posting at 10:42 is uncertain; check the site's applied list first"). Only a new model decision sends again.
5. Stop, durable state, lossless queues, and real connection-idle detection with reconnect.
6. Numeric limits the person sets (spend, daily sends) are counted by code.

Provider limits still exist; when one is hit, continue or recover context and report it, never drop work silently.

Use the person's selected resume and tailoring level. Approval state is context the model sees, not another permission request or a veto; record which file went. Changes to it apply across modes.

Aggressive tailoring is off limits. Its behavior and prompts change only through a change that applies to every mode. Its permitted stretches are not defects: nobody grades them down or sends them back for removal. Unrelated invented facts are still failures.

### Superseded decisions

This ADR supersedes every provision of ADRs 0012, 0013, 0020, 0024, 0027, 0039, 0041 and 0051 that withholds a tool by mode, vetoes, rewrites, caps, classifies or times out the model, restricts ordinary site writes through request windows, forces low effort, or hands the person a step the model can attempt. Those ADRs keep only what matches the six mechanics and Aggressive's protected behavior. Superseded, at least:

- [0012](0012-user-scoped-autonomous-application-authority.md): "model output alone is never application authority" and the deterministic executor binding; the CAPTCHA and anti-bot pause and "must not bypass security challenges"; treating preferences as consent to an unseen material attestation (declaration settings become instructions); from the 2026-10-29 update, the POST windows and refused requests, "one unambiguous saved account", the Google account-choice and proven-access rules, the four-write cap, the 90-second deadline and the handoff of unproven or ambiguous steps; the pause when the app cannot prove an action occurred (it becomes the ledger fact). Keeps: the settings themselves, the vault and secrets never as model input, MFA with the person, creating a new Google account with the person, the single send path, truthful outcomes, and "a solved challenge or successful sign-in never proves an application was sent".
- [0013](0013-hybrid-browser-observation-and-policy-execution.md): decisions 1, 3, 4 and 5; decision 6's preflight; decision 7's prepare-only containment. Keeps decision 2's page identity and stable control references (not its blocker classification) and decision 6's single execution with no automatic retry after an uncertain outcome.
- [0020](0020-streamed-model-requests-with-idle-and-total-budgets.md): total, task and per-attempt budgets and retry budgets. Keeps idle detection.
- [0024](0024-job-finder-browser-harness-and-three-apply-modes.md): the move reviewer; CAPTCHA and account-creation gating; the numbered-step rule and write windows (2026-10-27 amendment); the bounded field-change window and "Ambiguous and final-action requests stay blocked"; the low default effort for browser-agent turns; the 20-minute per-source and one-hour search budgets and the "time ceilings" consequence; the 2026-10-29 send preflight.
- [0027](0027-applications-finish-continue-and-bulk-apply.md): its conflicting checking provisions.
- [0039](0039-written-instructions-authorize.md): the replica-only harness-send consequence and the deterministic dispatch checks.
- [0041](0041-the-model-reads-the-page.md): the answer gate (verbatim or fact-checked only, keyword fallbacks, "one reminder, then the person"); the permission classifier; the code-enforced pay and declaration switches (they become instructions). The resume claim check (line 28, `resume-generation-grounding.ts`) carries Aggressive's number relaxations: it changes only as one change for every mode, and that PR states how Aggressive's output changes.
- [0051](0051-the-app-fixes-what-it-can-and-does-not-ask.md) line 25. Its "can the system fix it? then fix it" test stays as the general rule.

The old ADR text remains as history; this decision wins wherever it disagrees.

## Consequences

- Product changes remove the superseded checks and give the model missing facts, tools and useful prompts. They preserve the six mechanics and Aggressive's protected behavior across every affected path.
- CI and synthetic regression tests send only to local replicas. Authorized live runs, including scripted or unattended runs, use the owner's real profile, browser data, settings and application history; they are not switched to prepare-only and their ordinary site requests and permissions are not blocked. Never send a synthetic applicant to a real employer. Check the send ledger and the site before any send that could repeat one. Replicas never count toward live grades. [Real-site runs](../TESTING.md#real-site-runs) documents the existing driver command and evidence requirements.
- Personal resumes, credentials and authenticated browser state stay out of the repo. Live evidence stays in the campaign folder outside the repo and is never published. It may contain the owner's data, never passwords, cookies, tokens or MFA codes.
- A click, solved challenge or successful sign-in never proves an application was sent. The ledger records what happened, including uncertainty, and returns that fact to the model rather than turning our inability to prove an outcome into another permission gate.
