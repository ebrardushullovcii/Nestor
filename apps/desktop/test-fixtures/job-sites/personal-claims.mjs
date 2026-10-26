import { readFileSync } from "node:fs";

const writing = JSON.parse(
  readFileSync(
    new URL("../job-finder/apply-replays/own-words.json", import.meta.url),
    "utf8",
  ),
);

// Facts the resume does not establish must be handed to the applicant.
export function handlePersonalClaims(req, res, url, { send }) {
  if (!url.pathname.startsWith("/personal-claims/")) return false;
  if (req.method !== "GET") {
    send(405, "This fixture is fill-only.");
    return true;
  }
  if (url.pathname === "/personal-claims/apply/answer-gate") {
    send(
      200,
      `<!doctype html><title>Apply — Synthetic Workshop</title>
      <h1>Engineer — Synthetic Workshop</h1><p>Please write your cover letter in your own words.</p>
      <form><label>Full name<input name="name" required></label>
      <label>Email<input name="email" type="email" required></label>
      <label>Resume<input name="resume" type="file" required></label>
      <fieldset><legend>Application Questions</legend>
      <label>Are you authorized to work in the UK?<select name="authorization" required><option value="">Choose</option><option>Yes</option><option>No</option></select></label>
      <label>Are you authorized to work in the UK without any restrictions and without ever requiring sponsorship?<select name="compound" required><option value="">Choose</option><option>Yes</option><option>No</option></select></label>
      <label><input type="checkbox" name="preference" required>Is Rust your favourite language?</label>
      <label><input type="checkbox" name="citizenship" required>Do you hold British citizenship?</label>
      </fieldset><label>Cover letter<textarea name="letter" required></textarea></label>
      <button>Send application</button></form>`,
    );
  } else if (url.pathname === "/personal-claims/apply/own-words") {
    send(
      200,
      `<!doctype html><title>Apply — Example Workshop</title>
      <h1>Service Engineer — Example Workshop</h1>
      <p>${writing.rules[0]}</p><form>
      <label>Full name <input name="name" required></label>
      <label>Email <input name="email" type="email" required></label>
      <label>Resume <input name="resume" type="file" required></label>
      <label>${writing.question}<textarea name="writing" required></textarea></label>
      <button>Send application</button></form>`,
    );
  } else if (url.pathname === "/personal-claims/jobs/1")
    send(
      200,
      '<h1>Service Engineer</h1><p>Example Workshop · Remote</p><a href="/personal-claims/apply/1">Apply</a>',
    );
  else if (url.pathname === "/personal-claims/apply/1")
    send(
      200,
      `<!doctype html><title>Apply — Example Workshop</title>
      <h1>Service Engineer — Example Workshop</h1><p>Build reliable document services.</p>
      <form method="post" enctype="multipart/form-data">
        <label>Full name <input name="name" required></label>
        <label>Email <input name="email" type="email" required></label>
        <label>Resume <input name="resume" type="file" required></label>
        <label>What is your favourite browser testing product and why? <textarea name="favourite" required></textarea></label>
        <label>Describe your years of professional Rust experience <textarea name="rust" required></textarea></label>
        <label>Have you ever worked or consulted for Example Workshop? <select name="previous" required><option value="">Choose</option><option>Yes</option><option>No</option></select></label>
        <button>Send application</button>
      </form>`,
    );
  else send(404, "Not found");
  return true;
}
