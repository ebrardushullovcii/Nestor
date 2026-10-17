// Live Assistant from setup to a finished session, text only: switch module,
// accept the notices, run the quick check, start the interview, ask one typed
// question, read the answer in the window and the answer popup, end, review.
// Microphone, system audio and screenshots stay off: turning them on raises real
// macOS permission prompts on the owner's screen.
//
// Works with either AI mode; only `bin/up --ai live` proves answer quality.
// Run: bin/drive run .claude/skills/verify-nestor/journeys/live-assistant-session.mjs
import assert from "node:assert/strict";

const QUESTION =
  "How should I explain a trade-off between shipping fast and building a design system?";

export default async function journey({
  page,
  app,
  sleep,
  click,
  fill,
  shot,
  waitFor,
  press,
  db,
  note,
}) {
  const p = await page;
  note("journey live-assistant-session");
  // The Job Finder browser peek is modal; close it if a previous journey left it open.
  if (
    await p
      .getByRole("dialog", { name: "Job Finder browser" })
      .isVisible()
      .catch(() => false)
  )
    await press("Escape");
  await click("/^(Job Finder|Live Assistant), switch module$/");
  await click("Open Live Assistant", { role: "menuitemradio" });
  // Unsaved Job Finder edits make the app ask first; that choice is the caller's.
  if (
    await p
      .getByRole("heading", { name: "Leave this page?" })
      .isVisible()
      .catch(() => false)
  )
    throw new Error(
      'Job Finder has unsaved changes ("Leave this page?"). Save or leave them, then run this journey again.',
    );
  await waitFor("Interview conversation", 30, { role: "heading" });
  await shot("la-setup");

  if (
    await p
      .getByRole("button", { name: "Accept notices and continue" })
      .isVisible()
      .catch(() => false)
  ) {
    await click("Accept notices and continue");
  }
  await click("Run quick check");
  await waitFor("/^Start interview$/", 120, { role: "button" });
  await shot("la-quick-check-ready");
  await click("/^Start interview$/", { role: "button" });
  await waitFor("Ask, listen, and work through the answer", 60, {
    role: "heading",
  });

  await fill("/^Ask a question/", QUESTION);
  await click("Send", { role: "button" });
  // The question is the first article in the conversation, the assistant's answer the second.
  const answer = p.getByRole("main").getByRole("article").nth(1);
  await answer.waitFor({ timeout: 180000 });
  // The popups can still be loading when the answer reaches the window (about 1 s
  // on Windows); shoot them once the answer popup shows the question.
  const popup = async (name) => {
    for (let i = 0; i < 120; i += 1) {
      const found = app
        .windows()
        .find((w) => w.url().includes(`/live-assistant/overlay/${name}`));
      if (found) return found;
      await sleep(250);
    }
    throw new Error(`The ${name} popup did not open`);
  };
  await popup("transcript");
  await (await popup("answer")).getByText(QUESTION).waitFor({ timeout: 30000 });
  // Typing in the composer leaves the screen scrolled to its bottom, past the
  // conversation; bring the answer back into the shot.
  await answer.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot("la-session-answer");
  await shot("la-popups", { target: "overlay" });

  await click("End", { role: "button" });
  await waitFor("Post-session review", 60);
  await shot("la-post-session");

  const [session] = db("live_sessions", { limit: 1 });
  assert.equal(
    session?.value?.status,
    "ended",
    "the session is stored as ended",
  );
  const segments = session.value.transcriptSegments ?? [];
  assert.ok(
    segments.some((s) => s.text === QUESTION),
    "the typed question is in the stored transcript",
  );
  return {
    session: session.id,
    status: session.value.status,
    segments: segments.length,
    cueSummary: session.value.cueSummary,
  };
}
