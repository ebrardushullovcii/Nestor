# Live Assistant

The second module: a visible interview assistant. The person picks an interview target, accepts the required notices, runs a quick check of audio, transcription, screenshots and responses, then starts a session. During the session they type questions (or let mic and system audio add context) and get answers in the main window and in two popups (answer and transcript). Ending a session opens a post-session review.

## Sub-features

- `la-switch`: banner "Job Finder, switch module" › menu item "Open Live Assistant".
- `la-target`: "Interview target" panel ("General interview", language, cues) and "Change settings"; "Prepare interview" from an application links here with that job.
- `la-notices`: "Accept notices and continue".
- `la-capture-optins`: checkboxes "Enable microphone", "Enable system audio", "Enable screenshots".
- `la-quick-check`: "Run quick check", then "Start interview".
- `la-session`: heading "Ask, listen, and work through the answer", textbox "Ask a question, paste a screenshot, …", "Send", "Attach image", "Capture screen", "Pause", "End", "Session health".
- `la-popups`: answer and transcript popups (`/live-assistant/overlay/answer`, `/live-assistant/overlay/transcript`) with "Copy answer".
- `la-review`: "Post-session review", "Save prep", "Export notes", deleting a session.
- `la-audio`: "Test mic", "Test system", "Start mic audio", "Start system audio", browser captions.

## How to get to it (user POV)

- The module switch in the banner.
- Applications › a submitted application › "Prepare interview".

## Driving it with verify-nestor

Preconditions: baseline. Either AI mode; only `--ai live` proves answer quality.

- **Setup to session.** `$V/drive click "/^(Job Finder|Live Assistant), switch module$/"`, `$V/drive click "Open Live Assistant" --role menuitemradio`, `$V/drive click "Accept notices and continue"`, `$V/drive click "Run quick check"`, `$V/drive wait "/^Start interview$/" 120 --role button`, `$V/drive click "/^Start interview$/" --role button`.
- **A question.** `$V/drive fill "/^Ask a question/" "<question>"`, `$V/drive click Send --role button`; the answer arrives as the second article in the conversation. `$V/drive shot answer`, `$V/drive shot popups --target overlay`.
- **End.** `$V/drive click End --role button`, `$V/drive wait "Post-session review"`. Proof: `$V/db live_sessions 1` with `status: "ended"` and the typed question in `transcriptSegments`.
- Whole flow: `journeys/live-assistant-session.mjs`. Measured: about 30 s; a live answer took about 15 s.
- Not run through this skill: audio, screenshots, image attach, Save prep, Export notes, delete, a job-specific target.

## Gotchas

- Leave microphone, system audio and screenshots off unless the owner asked: they raise real macOS permission prompts on the owner's screen, and an isolated instance has no grants. Without speech-to-text set up, "Start mic audio" stays disabled ("Set up speech-to-text first").
- The popups are content-protected and, in a verify instance, not always-on-top (the patch removes it so they do not float over the owner's apps). A run cannot prove always-on-top or click-through behaviour.
- The popups show "PROTECTION NOT VERIFIED" in a dev build; that is the app's own label, not a harness fault.
- Switching modules with unsaved Job Finder edits (for example straight after the `setup` stage) asks "Leave this page?". The journey stops with that message instead of choosing for the person; save or leave first.
- Sessions live in `live-assistant-workspace.json.sqlite`, not the Job Finder database; `$V/db live_sessions` finds it.
