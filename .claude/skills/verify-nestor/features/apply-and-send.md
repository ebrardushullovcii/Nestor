# Apply and send

Apply queues approved resumes in the applications store. Settings offers Fill in for me (fills the form and leaves Send to the person) and Send for me (allows automatic sending through the send guards). Each queued application retains its mode; a later setting change cannot upgrade it. Test sends go only to the isolated instance's replica sites.

## Sub-features

- Shortlisted: Apply one, selected jobs, the current page or every approved matching job. Work runs in bounded background tabs.
- Applications: Open application opens the exact filled form; Stop closes its tab and stops unsent work. What Apply filled in / What was sent shows the recorded answers, attachments and receipt.
- Sidebar: record the person's instruction, then apply_to_jobs with an ids selection or an Approved (stage=resume) filter and exclusions. The instruction freezes matching jobs once; later arrivals stay out. applications_for_jobs maps job ids to work ids; list_application_work and get_application_details read the store. open_application, stop_application and send_application use work ids.
- A plain Apply follows the saved mode. An explicit fill-only instruction stays fill-only even with Send for me saved. An explicit send instruction can authorize the ready-form send command without changing the default setting.
- Sidebar Needs you uses list_needs_you/get_need and answer_need; one answer releases all applications waiting on that question. Saved answers use the shared add/edit/forget commands and per-change Undo for future forms. open_need opens a source sign-in item; retry_need checks that source again after the person signs in. Application browser steps use open_need and check_need and can continue automatically once the page is accessible. The retired Application documents editor is not an available fallback.

## How to get to it (user POV)

- Shortlisted > Approved > Apply, or open a job and Apply.
- Applications > a job > Open application / Stop / What was sent.
- Settings > Applying > Fill in for me or Send for me.
- Open the Assistant and ask to apply to this job, the selection, the page or all approved jobs; ask to open or stop a named application's form.

## Driving it with verify-nestor

Use live AI, synthetic profile/resume data and this instance's replica URLs. Seed only preconditions that are not being proved, and report them.

- Queue one job through chat in Fill mode. Inspect applications.mode/state and the screen. Wait outside the chat for ready; there must be no replica submission.
- Change the saved mode to Send for me, ask Apply again for the active job, and prove its mode and attempt did not change.
- Ask chat to open that application. Capture the retained browser form; inspect its answers and attached file. Ask Stop; inspect the stopped row and closed binding.
- Select several approved jobs and ask chat to apply to the selection. Check only those rows were queued. For all approved jobs use the compact filter; exclusions and later arrivals must stay out. A store-level test must also cover more than one page.
- In Send mode queue approved work through chat. Prove the site's receipt, a submitted application row, and the screen's What was sent. An unconfirmed send is not retried.
- For a ready Fill form, ask chat explicitly to send it. Prove the receipt and unchanged default setting. A preparation instruction or saved Fill mode alone must not authorize send_application.

## Gotchas

- The browser peek covers the app. Escape closes it; an unfocused instance may park pages in a hidden browser window, so use shot --target browser.
- A restart closes prepared browser pages. Open restores the filled form when it can verify the saved fields and attachments; otherwise it refills in Fill mode for review. An armed send interrupted without confirmation stays uncertain and cannot be retried automatically.
- Queued, ready and submitted are different states. A tracker status or a tool-list assertion is not proof of an application send.
- Never send to a non-loopback site. The verify-nestor send guard and submissions.jsonl prove where writes went.

## Needs you and saved answers

Sidebar › Needs you uses the same paged list/detail layout and keyboard selection as the other job lists. Questions are oldest first. New arrivals and background refreshes must not replace an active editor or move a draft to another task. Drafts survive navigation and restart. Yes/No answers are buttons.

- Answer one task with Save this answer for next time selected. Every matching, unambiguous application waiting on that question should continue, and a later application should reuse it. Country-dependent answers retain their scope.
- Saved answers › Add answer is the only home for reusable answer text. Save Years of analysis experience = 5 and Years of coordination experience = 14, then apply to the replica /clientnest/jobs/33 through Find jobs and Shortlisted. Verify both actual form fields, and that neither numeric question appears in Needs you. Repeat with a new attempt.
- Edit and forget saved answers here. Profile retains structured eligibility and contact preferences; it has no reusable-answer editor. Applications shows a read-only review of the answers prepared for sending.
- Source sign-ins sit below the application items in one group, "N job sites need you to sign in" (folded while any application item waits); sites on one host are one row, "Sign in to <label>", with the host as meta. Open the site, finish the step, then "I've signed in, check it": the row reads Checking…, then leaves, or says "Still can't read it". It remains until search can read that site, independently of any application.
- "Work through selected" (or the group's "Sign in to each") walks the items: questions open in the detail pane with "N of M"; each site opens in the browser with "Signing in · <label> · N of M [Done, next site] [Skip]". Hiding the browser pauses the walk ("Paused at N of M · Continue").
- Filled forms waiting for Send are listed under "Ready for you to send (N)", not counted as Needs you. With nothing blocked the empty list says "Nothing is blocked. N application(s) … waiting for your Send." with "Review and send".
- After the person's own Submit on a kept form the site confirms, the tab closes, the browser hides when that was its last tab, and a toast says "Sent: <title> at <company>" with "Open in Applications".

Proof: screenshots before/after, the job store's needs_you, needs_you_drafts, form_answers and applications rows, and the actual replica form fields. Check the sidebar Assistant's typed Needs-you commands against the same rows. Text supplied by the person is required before chat saves a reusable answer.
