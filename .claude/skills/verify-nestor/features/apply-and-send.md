# Apply and send

Apply queues approved resumes in the applications store. Settings offers Fill in for me (fills the form and leaves Send to the person) and Send for me (allows automatic sending through the send guards). Each queued application retains its mode; a later setting change cannot upgrade it. Test sends go only to the isolated instance's replica sites.

## Sub-features

- Shortlisted: Apply one, selected jobs, the current page or every approved matching job. Work runs in bounded background tabs.
- Applications: Open application opens the exact filled form; Stop closes its tab and stops unsent work. What Apply filled in / What was sent shows the recorded answers, attachments and receipt.
- Sidebar: record the person's instruction, then apply_to_jobs with an ids selection or an Approved (stage=resume) filter and exclusions. The instruction freezes matching jobs once; later arrivals stay out. applications_for_jobs maps job ids to work ids; list_application_work and get_application_details read the store. open_application, stop_application and send_application use work ids.
- A plain Apply follows the saved mode. An explicit fill-only instruction stays fill-only even with Send for me saved. An explicit send instruction can authorize the ready-form send command without changing the default setting.
- Needs-you answers through the sidebar await the rebuilt inbox's command cutover. The retired Application documents editor is not an available fallback.

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
- A restart loses prepared browser pages. Finish or stop ready forms before restarting; new work and instructions remain in storage.
- Queued, ready and submitted are different states. A tracker status or a tool-list assertion is not proof of an application send.
- Never send to a non-loopback site. The verify-nestor send guard and submissions.jsonl prove where writes went.
