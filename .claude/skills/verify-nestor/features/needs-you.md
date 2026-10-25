# Needs you

Needs you lists application questions, sign-in, CAPTCHA and verification steps. One answer releases every application waiting on that question. Saved answers are managed here. The list holds its position while an answer is edited, and drafts belong to the exact question.

## Sub-features

- Application questions: text, numbers, direct Yes/No choices, choices and file picking.
- Save and continue; optional reuse; saved-answer editing, filtering and forgetting.
- Draft recovery and conflict detection without moving an answer to another task.
- Browser access steps: open the exact application and check the page after completing the step.
- Source sign-in items: source label and URL, Open to sign in, Retry; search owns their persistence and completion.

## How to get to it (user POV)

Apply to approved jobs from Shortlisted. If a required answer is missing or the site needs the person, open Needs you from the sidebar. Saved answers is the second tab; Profile has no screener-answer editor.

## Driving it with verify-nestor

Use an isolated live-AI build and replica sites. For a shared unanswered question, use a synthetic profile without a phone number and apply to two `/board/` jobs. Open Needs you, type an answer, navigate away and back, and restart before submitting it to check recovery. Save it once with reuse selected. Check both application rows continue and no duplicate question remains. Apply to another job to check reuse, then edit and forget the answer from Saved answers. Check `needs_you`, `needs_you_drafts`, `form_answers` and `applications` as well as screenshots; no send is needed for this check.

For access steps, use the replica `/lever/` CAPTCHA or `/workday/` account wall. Open it from Needs you. Checking an unfinished wall must keep the item open; complete the browser step and check again. Source Retry must leave the item visible until search removes it after a successful read.

## Gotchas

- Profile facts and resume text still supply known answers before a question is asked. Clear only the synthetic fact needed for the check.
- Browser peek is modal; close it before editing the answer in the app.
- A draft-save conflict offers Reload saved draft. It never silently overwrites another window's answer.
- The source-ticket producer and retry runner must be present to exercise source items end to end; a component test proves only their rendering and bridge calls.
