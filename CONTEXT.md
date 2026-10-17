# Nestor

Nestor is an agent-first desktop product for job search, resume preparation, safe application assistance, and interview support. This file is a glossary only; product behavior lives in `docs/PRODUCT.md`, boundaries in `docs/ARCHITECTURE.md`, and decisions in `docs/adr/`.

## Job Finder Language

**Application automation mode**:
The user's selected authority level for one application scope: prepare only,
confirm before submit, or autonomous submit.
_Avoid_: hidden auto-apply flag, implicit submit permission

**Application authority envelope**:
The explicit, inspectable, revocable policy that scopes what Job Finder may do,
for which jobs, with which answers and documents, at what volume, until when, and
where it must stop.
_Avoid_: blanket consent, preferences imply everything

**Autonomous submit**:
An application mode in which Job Finder may perform the final employer-site
submission action because the exact application and action are inside the saved
authority envelope.
_Avoid_: prepare-only auto-apply, unscoped submit

**Resume coverage policy**:
The rule for which profile work-history records appear in a generated resume and at what level of detail.
_Avoid_: irrelevant jobs, hidden jobs

**Career-family fit**:
The relationship between a profile work-history record and the candidate's target professional lane.
_Avoid_: relevance

**Weak-fit work-history record**:
A work-history record close enough to the target lane to include in compact form or show as a review suggestion.
_Avoid_: irrelevant role

**Gap-coverage role**:
A weak-fit work-history record that may be worth compact inclusion because omitting it creates a meaningful work-history gap.
_Avoid_: filler job

**Resume review guidance**:
App-only guidance that explains why a resume draft item may need user review before export.
_Avoid_: export note, resume annotation

**Resume tailoring style**:
The user's preferred strength of resume rewriting for a target job, ranging from light touch to strong rewrite.
_Avoid_: aggression, creativity level

**Functional layout variety**:
Resume template variety based on section order, hierarchy, density, and content emphasis rather than color differences.
_Avoid_: theme color variety

**Apply visual checkpoint**:
A bounded screenshot and structured visual observation captured during safe apply to explain visible form state, blockers, validation, upload controls, or recovery needs.
_Avoid_: continuous apply recording, visual auto-submit

**Source-generic visual snapshot**:
A bounded browser screenshot captured to explain visible page state without encoding job-board-specific workflow rules.
_Avoid_: board-specific screenshot rule, visual shortcut

## Live Assistant Language

**Interview live session**:
A user-started Live Assistant session where listening, transcript context, captures, overlays, and model suggestions are active under explicit user control.
_Avoid_: background listening, ambient interview mode

**Live-session setup gate**:
The pre-session consent step where the user enables interview capture capabilities before Live Assistant can listen, capture, send, or retain live-session context.
_Avoid_: blanket consent, hidden permission

**Session audio**:
The microphone and meeting/system audio captured during an Interview live session for transcription and suggestion context.
_Avoid_: user audio only, hidden recording

**Interview cue trigger**:
The event that turns live transcript or screenshot context into a model request for a Live Assistant suggestion.
_Avoid_: send everything, passive model stream

**Interview cue card**:
A concise model suggestion optimized for quick live reading during an Interview live session.
_Avoid_: full chat answer, essay response

**Rolling cue context**:
The bounded model context for an Interview cue trigger, combining recent transcript, active screenshots, target context, relevant prep artifacts, and a compact session summary.
_Avoid_: full transcript resend, contextless latest line

**Cue visual batch**:
The temporary set of screenshots collected for the next Interview cue trigger.
_Avoid_: last screenshot only, permanent screen archive

**Live answer overlay**:
The semi-transparent Live Assistant surface that shows model-generated suggestions during an Interview live session.
_Avoid_: main panel, transcript window

**Live transcript overlay**:
The semi-transparent Live Assistant surface that shows session transcript and queued visual context during an Interview live session.
_Avoid_: answer window, raw recorder

**Screen-share-private overlay**:
A Live Assistant window that uses supported platform capture protection to keep app-owned live assistance surfaces out of ordinary screen sharing when authorized.
_Avoid_: stealth overlay, proctoring bypass, capture evasion

**Authorized capture-protection extension**:
A product goal for future OS, meeting-platform, enterprise, or company-approved mechanisms that fully exclude Live Assistant live overlays from authorized capture surfaces with consent from the relevant parties.
_Avoid_: unauthorized hiding, security bypass, proctoring evasion

**Live-session history**:
The retained structured record of an Interview live session after it ends.
_Avoid_: raw recording archive, full capture dump

## Relationships

- A **Resume coverage policy** uses **Career-family fit** to decide whether a work-history record is omitted, compact, or detailed.
- A **Weak-fit work-history record** can become a **Gap-coverage role** when omitting it creates a meaningful continuity problem.
- **Resume review guidance** is shown inside the app and must not be rendered into exported resume content.
- **Functional layout variety** is the priority for resume templates; color changes alone do not justify a new apply-safe template.
- An **Apply visual checkpoint** and a **Source-generic visual snapshot** provide structured evidence only; browser actions, selectors, and workflow rules remain owned by typed workflow logic.
- An **Interview live session** starts only from an explicit user action and is guarded by a **Live-session setup gate**.
- An **Interview cue trigger** uses **Rolling cue context**, and may include a temporary **Cue visual batch**.
- A **Live answer overlay** and **Live transcript overlay** are independent consumers of the same session state.
- A **Screen-share-private overlay** is best-effort and platform-dependent until an **Authorized capture-protection extension** exists.
- **Live-session history** keeps structured retained content, not raw audio or unpinned screenshot archives by default.

## Flagged Ambiguities

- "irrelevant jobs" was used for both unrelated work history and useful but weak-fit history; resolved: use **Career-family fit** for the relationship and **Resume coverage policy** for inclusion behavior.
- "hidden overlay" can imply unauthorized capture evasion; resolved: use **Screen-share-private overlay** for current best-effort behavior and **Authorized capture-protection extension** for future approved stronger exclusion.
