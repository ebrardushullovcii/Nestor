// A two-step application in the shape Workday's boards use: a listing whose
// "Apply" opens the form, a step list with the current step marked, and
// "Save and Continue" that keeps the step as the site's own draft before the
// next one shows. Coming back to a saved step shows what was saved. Only the
// last step's Submit sends the application.

const steps = [
  {
    title: "My Information",
    fields: [
      ["firstName", "First Name"],
      ["lastName", "Last Name"],
      ["email", "Email"],
    ],
  },
  {
    title: "My Experience",
    fields: [
      ["years", "Years of experience"],
      ["linkedin", "LinkedIn"],
    ],
  },
];

/** The site's draft, per visitor: what Save and Continue kept. */
const drafts = new Map();

const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"]/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );

function stepPage(index, draft) {
  const step = steps[index];
  const last = index === steps.length - 1;
  return `<!doctype html><title>Apply — Steps Replica</title>
<h1>Apply: Field Engineer</h1><p>Steps Replica · Remote</p>
<ol>${steps.map((entry, at) => `<li${at === index ? ' aria-current="step"' : ""}>${entry.title}</li>`).join("")}</ol>
<form method="post" action="/steps-shape/apply/1/step/${index + 1}">
  ${step.fields
    .map(
      ([name, label]) =>
        `<p><label for="${name}">${label} *</label><input id="${name}" name="${name}" required value="${escape(draft[name])}"></p>`,
    )
    .join("\n  ")}
  ${index > 0 ? `<a href="/steps-shape/apply/1?step=${index}">Back</a>` : ""}
  <button>${last ? "Submit" : "Save and Continue"}</button>
</form>`;
}

export async function handleStepsShape(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  if (!url.pathname.startsWith("/steps-shape/")) return false;
  const rest = url.pathname.slice("/steps-shape".length);
  let visitor = /(?:^|;\s*)steps_replica=([^;]+)/u.exec(
    req.headers.cookie ?? "",
  )?.[1];
  if (!visitor) {
    visitor = Math.random().toString(36).slice(2, 12);
    res.setHeader("Set-Cookie", `steps_replica=${visitor}; Path=/steps-shape`);
  }
  const draft = drafts.get(visitor) ?? {};
  drafts.set(visitor, draft);
  if (rest === "/jobs/1") {
    send(
      200,
      `<!doctype html><title>Field Engineer</title><h1>Field Engineer</h1><p>Steps Replica · Remote</p><p>Keep customer systems running.</p><a href="/steps-shape/apply/1">Apply</a>`,
    );
    return true;
  }
  const saved = /^\/apply\/1\/step\/(\d+)$/u.exec(rest);
  if (saved && req.method === "POST") {
    const index = Number(saved[1]) - 1;
    const fields = await readPost(req);
    Object.assign(draft, fields);
    if (index === steps.length - 1) {
      logPost(url.pathname, { ...draft });
      send(200, "<h1>Thank you! Your application has been received.</h1>");
      return true;
    }
    // The site keeps the step and shows the next one.
    logPost(url.pathname, fields);
    res.writeHead(303, { Location: `/steps-shape/apply/1?step=${index + 2}` });
    res.end();
    return true;
  }
  if (rest === "/apply/1") {
    const index = Math.min(
      Math.max(Number(url.searchParams.get("step") ?? "1") - 1, 0),
      steps.length - 1,
    );
    send(200, stepPage(index, draft));
    return true;
  }
  send(404, "Not found");
  return true;
}
