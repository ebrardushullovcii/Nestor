import { createScaleRouter } from "./scale/router.mjs";
import { handlePermitFit } from "./sites/permit-fit.mjs";
import http from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { handleMoreSites, moreSites } from "./sites/router.mjs";
import { handleRealUploadShapes } from "./real-upload-shapes.mjs";
import { handleFillChores } from "./fill-chores.mjs";
import { handleStepsShape } from "./steps-shape.mjs";
import { handlePersonalClaims } from "./personal-claims.mjs";
import { handleUploadRepair } from "./upload-repair.mjs";
import { handleHandoverOptions } from "./handover-options.mjs";
import { handleRememberedQuestions } from "./remembered-questions.mjs";
import { handleRemoteSearch } from "./remote-search.mjs";

// All data, accounts and endpoints are synthetic and local to this server.
const confirmation = "Thank you! Your application has been received.";
const sites = {
  authboard: "Signed-in Paper Jobs",
  board: "Orbit Paper Jobs",
  lever: "Copper Kite Careers",
  greenhouse: "Moss Lantern Careers",
  workday: "Velvet Comet Careers",
  gatekeeper: "Pebble Orbit Careers",
  empty: "Quiet Harbor Careers",
};
const roles = [
  [
    "Full-stack Engineer, Cloud Gardens",
    "Cloud Garden Workshop",
    "Remote, Europe",
    "12d",
  ],
  [
    "Backend Engineer, Lantern Services",
    "Lantern Pixel Works",
    "Remote, Worldwide",
    "3d",
  ],
  [
    "Platform Engineer, Comet Systems",
    "Comet Teacup Labs",
    "Remote, Europe",
    "8d",
  ],
  [
    "Frontend Engineer, Paper Interfaces",
    "Paper Orbit Studio",
    "Remote, Americas",
    "1d",
  ],
  [
    "Data Engineer, Meadow Pipelines",
    "Meadow Byte Guild",
    "Remote, Worldwide",
    "5d",
  ],
  [
    "Senior Full-stack Engineer, Marble Tools",
    "Marble Finch Systems",
    "Remote, Europe",
    "15d",
  ],
  [
    "Backend Engineer, Willow APIs",
    "Willow Circuit House",
    "Remote, Worldwide",
    "2d",
  ],
  [
    "Frontend Engineer, Dusk Design Systems",
    "Dusk Acorn Collective",
    "Remote, Europe",
    "6d",
  ],
  [
    "Frontend Engineer, Cedar Components",
    "Cedar Compass Studio",
    "Remote, Europe",
    "2d",
  ],
  [
    "Full-stack Engineer, Spruce Workspace",
    "Spruce Lantern Works",
    "Remote, Worldwide",
    "4d",
  ],
];
const jobs = roles.map(([title, company, region, age], index) => ({
  id: String(index + 1),
  title,
  company,
  region,
  age,
}));
const accounts = new Map();
const sessions = new Map();
const assets = new Map(
  ["styles.css", "client.js"].map((name) => [
    name,
    readFileSync(new URL(name, import.meta.url)),
  ]),
);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

function page(site, title, content, head = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title><link rel="stylesheet" href="/assets/styles.css">${head}<script src="/assets/client.js" defer></script></head>
    <body class="${site}"><header><a href="/${site}/">${escape(sites[site] || "Local replica job sites")}</a><a href="/">All test sites</a></header>
    <main><p class="fixture">Local test fixture • Fictional jobs • Use synthetic data only</p>${content}</main>
    ${
      site === "gatekeeper"
        ? `<aside id="cookie-banner" role="dialog" aria-label="Cookie preferences"><h2>Cookie preferences</h2><p>This local fixture remembers your cookie choice in this tab.</p><button type="button" data-cookie="accept">Accept</button> <button type="button" data-cookie="reject">Reject</button></aside>
      <button id="chat-toggle" class="chat-bubble" type="button" aria-expanded="false" aria-controls="chat-panel">Chat with us</button><aside id="chat-panel" hidden><p>Welcome! This is a fictional support widget.</p><button type="button" id="chat-close">Close chat</button></aside>`
        : ""
    }</body></html>`;
}

function input(name, label, type = "text", required = true, attributes = "") {
  return `<label class="field" for="${name}">${label}${required ? " *" : ""}<input id="${name}" name="${name}" type="${type}" ${required ? "required" : ""} ${attributes}></label>`;
}
function textarea(name, label, required = false) {
  return `<label class="field" for="${name}">${label}${required ? " *" : ""}<textarea id="${name}" name="${name}" rows="5" ${required ? "required" : ""}></textarea></label>`;
}
function select(name, label, options, required = true) {
  return `<label class="field" for="${name}">${label}${required ? " *" : ""}<select id="${name}" name="${name}" ${required ? "required" : ""}><option value="">Select an option</option>${options.map((option) => `<option>${escape(option)}</option>`).join("")}</select></label>`;
}
function checkbox(name, label, required = true) {
  return `<label class="check"><input type="checkbox" name="${name}" value="yes" ${required ? "required" : ""}> ${label}</label>`;
}
function yesNo(name, label) {
  return `<fieldset><legend>${label} *</legend>${["Yes", "No"].map((value) => `<label class="check"><input type="radio" name="${name}" value="${value}" required> ${value}</label>`).join("")}</fieldset>`;
}
function upload(name, label, style = "button", required = true) {
  const documentLabel =
    {
      resume: "Resume / CV",
      coverLetterFile: "Cover letter",
      portfolio: "Portfolio",
      transcript: "Academic transcript",
    }[name] ?? label;
  const file = `<input id="${name}" name="${name}" type="file" accept=".pdf,.doc,.docx,.txt" ${required ? "required" : ""} aria-label="${escape(documentLabel)}" ${style === "label" ? "hidden" : `class="${style === "opacity" ? "opacity-file" : "visually-hidden"}"`}>`;
  const control =
    style === "label" || style === "opacity"
      ? `<label class="button upload-label" for="${name}" tabindex="0">${label}${style === "opacity" ? file : ""}</label>${style === "label" ? file : ""}`
      : `<button type="button" data-upload="${name}">${label}</button>${file}`;
  return `<div class="upload"><p>${escape(documentLabel)}${required ? " *" : " (optional)"}</p>${control}<span data-file-name="${name}" aria-live="polite">No file selected</span>${style === "drop" ? `<div class="drop-zone" data-drop="${name}" tabindex="0" role="button" aria-label="Drop resume here or choose a file">Drop your resume here</div>` : ""}</div>`;
}
function form(action, content, attributes = "") {
  return `<form action="${action}" method="post" enctype="multipart/form-data" ${attributes}>${content}</form>`;
}
function applyPath(site, id) {
  return `/${site === "board" || site === "authboard" ? "employer-a" : site}/apply/${id}`;
}
function listing(site) {
  return page(
    site,
    sites[site],
    `${site === "authboard" ? '<a href="/authboard/signout">Sign out</a>' : ""}<h1>Open software roles</h1><p>Find your next role with our fictional teams. All positions are full-time.</p><section class="jobs">${(site === "empty" ? [] : jobs).map((job) => `<article class="job"><div><p>${job.company}</p><h2><a href="/${site}/${site === "gatekeeper" ? "security" : "jobs"}/${job.id}" data-job-id="${job.id}">${job.title}</a></h2><p>${job.region} · Full-time</p></div><span class="age">${job.age}</span></article>`).join("")}</section>`,
  );
}
function detail(site, job) {
  const label =
    site === "lever"
      ? "Apply for this job"
      : site === "board"
        ? "Apply now"
        : "Apply";
  return page(
    site,
    job.title,
    `<p>${job.company} · ${job.region} · Posted ${job.age} ago</p><h1>${job.title}</h1><h2>About the role</h2><p>Build reliable software for a fictional collaborative planning product. Work with a small team on accessible interfaces, APIs, data pipelines and developer tools.</p><h2>What you will do</h2><ul><li>Design and ship maintainable software with TypeScript, SQL and automated tests.</li><li>Collaborate across product and engineering.</li><li>Improve performance, accessibility and reliability.</li></ul><h2>What you bring</h2><p>Professional software development experience, clear communication and an interest in learning.</p><a class="button" href="${applyPath(site, job.id)}" ${site === "gatekeeper" ? 'target="_blank" rel="noopener"' : ""}>${label}</a>`,
  );
}

function application(site, job, error = "") {
  const heading = `<h1>Apply: ${job.title}</h1><p>${job.company} · ${job.region}</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}`;
  let fields;
  if (site === "board") {
    fields =
      input("name", "Name") +
      input("email", "Email", "email") +
      input("phone", "Phone", "tel") +
      upload("resume", "Attach resume", "label") +
      textarea("coverLetter", "Cover letter") +
      checkbox("certify", "I certify the information is true") +
      "<button>Submit</button>";
  } else if (site === "lever") {
    const humanCheck =
      job.id === "1"
        ? `<div class="captcha">${checkbox("human", "I am not a robot", false)}<small>Local fake CAPTCHA</small><p id="captcha-error" class="error" role="alert" hidden>Please verify you are human</p></div>`
        : "";
    fields =
      select("location", "Which location are you applying for?", [
        "Remote, Europe",
        "Remote, Worldwide",
        "Remote, Americas",
      ]) +
      upload("resume", "ATTACH RESUME/CV", "opacity") +
      input("name", "Full name") +
      input("email", "Email", "email") +
      input("phone", "Phone", "tel") +
      input(
        "currentLocation",
        "Current location",
        "text",
        true,
        'list="locations" autocomplete="address-level2"',
      ) +
      '<datalist id="locations"><option value="Cloud Harbor"><option value="Lantern Valley"><option value="Willow Bay"></datalist>' +
      input("linkedin", "LinkedIn URL", "url", false) +
      textarea("additionalInformation", "Additional information") +
      (job.id === "8"
        ? checkbox("certify", "I certify the information is true") +
          checkbox("privacy", "I acknowledge the privacy notice") +
          checkbox("terms", "I agree to the terms and conditions")
        : "") +
      checkbox(
        "backgroundConsent",
        "I consent to a background check",
        job.id !== "8",
      ) +
      humanCheck +
      "<button>Submit application</button>";
  } else if (site === "greenhouse") {
    fields =
      input("firstName", "First name") +
      input("lastName", "Last name") +
      input("email", "Email", "email") +
      input("phone", "Phone", "tel") +
      upload("resume", "Attach", "drop") +
      upload(
        "coverLetterFile",
        "Attach cover letter",
        "button",
        job.id === "8",
      ) +
      (job.id === "7"
        ? upload("portfolio", "Attach portfolio", "label") +
          upload("transcript", "Attach academic transcript", "button")
        : "") +
      select("experience", "Years of professional experience", [
        "0–1",
        "2–4",
        "5–9",
        "10+",
      ]) +
      yesNo(
        "authorized",
        "Are you legally authorized to work in this country?",
      ) +
      yesNo("sponsorship", "Will you require sponsorship?") +
      textarea("motivation", "Why do you want to work here?", true) +
      `<fieldset><legend>Voluntary self-identification (optional)</legend><p>These optional answers do not affect this fictional application.</p>${select("gender", "Gender", ["Woman", "Man", "Non-binary", "Prefer not to say"], false)}${select("race", "Race", ["Asian", "Black", "White", "Hispanic or Latino", "Multiracial", "Self-describe / other", "Prefer not to say"], false)}${select("veteran", "Veteran status", ["Veteran", "Not a veteran", "Prefer not to say"], false)}</fieldset><button>Submit application</button>`;
  } else {
    fields =
      `<input type="hidden" name="jobId" value="${job.id}">` +
      input("name", "Full name") +
      input("email", "Email", "email") +
      input("phone", "Phone", "tel") +
      upload("resume", "Attach resume") +
      textarea("coverLetter", "Cover letter") +
      '<p id="autosave-status" role="status">Your answers save as you type.</p><p id="submit-error" class="error" role="alert"></p><button>Submit application</button>';
  }
  return page(
    site,
    `Apply: ${job.title}`,
    heading +
      form(
        site === "gatekeeper"
          ? "/gatekeeper/api/submit"
          : applyPath(site, job.id),
        fields,
        `data-site="${site}"`,
      ),
  );
}

const pendingFactors = new Map();
function workdayVerification(job, error = "") {
  return page(
    "workday",
    "Two-step verification",
    `<h1>Two-step verification</h1><p>Enter the verification code. This local replica's made-up code is 482917.</p>${error ? `<p role="alert">${escape(error)}</p>` : ""}` +
      form(
        `/workday/verify/${job.id}`,
        input(
          "code",
          "Verification code",
          "text",
          true,
          'autocomplete="one-time-code"',
        ) + "<button>Verify</button>",
      ),
  );
}
function workday(job, stage, session, error = "") {
  const base = `/workday/apply/${job.id}`;
  const heading = `<h1>${job.title}</h1>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}`;
  if (stage === "application" && session) {
    const steps = [
      "My Information",
      "My Experience",
      "Application Questions",
      "Review",
    ];
    const content = `<input type="hidden" name="jobId" value="${job.id}">
      <ol class="stepper">${steps.map((name, index) => `<li data-step-label="${index}" ${index === 0 ? 'aria-current="step"' : ""}>${index + 1}. ${name}</li>`).join("")}</ol>
      <fieldset data-step="0"><legend>My Information</legend><button type="button" data-autofill>Autofill with resume</button>
      ${select("source", "How did you hear about this job?", ["Job board", "Company website", "Referral", "Other"])}${input("firstName", "First name")}${input("lastName", "Last name")}${input("email", "Email", "email", true, `value="${escape(session.email)}"`)}${input("phone", "Phone", "tel")}${input("address", "Address")}${input("city", "City")}${input("postalCode", "Postal code")}${input("country", "Country")}<button type="button" data-next>Save and continue</button></fieldset>
      <fieldset data-step="1" hidden disabled><legend>My Experience</legend><div id="experience-blocks"></div><button type="button" id="add-experience">Add</button>${upload("resume", "Upload resume")}<button type="button" data-back>Back</button> <button type="button" data-next>Save and continue</button></fieldset>
      <fieldset data-step="2" hidden disabled><legend>Application Questions</legend>${yesNo("authorized", "Are you legally authorized to work in this country?")}${yesNo("sponsorship", "Will you require sponsorship?")}${yesNo("remote", "Can you work remotely?")}${input("notice", "What is your notice period?")}${input("strengths", "Which technical skills would you bring?")}<button type="button" data-back>Back</button> <button type="button" data-next>Save and continue</button></fieldset>
      <fieldset data-step="3" hidden disabled><legend>Review</legend><div id="review-summary"></div>${checkbox("terms", "I have read and agree to the terms")}<button type="button" data-back>Back</button> <button type="button" data-save-review>Save and continue</button> <button type="submit">Submit</button></fieldset><p id="workday-status" role="status"></p>`;
    return page(
      "workday",
      "Application",
      heading + form(base, content, 'id="workday-form"'),
    );
  }
  if (stage === "register" || stage === "signin") {
    const register = stage === "register";
    return page(
      "workday",
      register ? "Create account" : "Sign in",
      heading +
        `<h2>${register ? "Create account" : "Sign in"}</h2><p>Use a made-up email and password. Accounts disappear when this server stops.</p>` +
        form(
          `/workday/account/${register ? "register" : "signin"}/${job.id}`,
          input("email", "Email", "email") +
            input("password", "Password", "password") +
            (register
              ? input("verifyPassword", "Verify password", "password") +
                checkbox("agree", "I agree") +
                checkbox(
                  "enableMfa",
                  "Enable two-step verification for this local test",
                  false,
                )
              : "") +
            `<button>${register ? "Create account" : "Sign in"}</button>`,
        ),
    );
  }
  if (stage === "wall" || stage === "application") {
    return page(
      "workday",
      "Sign in / Create account",
      heading +
        `<h2>Sign in / Create account</h2><a class="button" href="${base}?stage=signin">Sign in</a> <a class="button" href="${base}?stage=register">Create account</a>${session ? ` <a class="button" href="${base}?stage=application">Continue application</a>` : ""}`,
    );
  }
  return page(
    "workday",
    "Start application",
    heading +
      `<h2>How would you like to apply?</h2><div class="choices"><a class="button" href="${base}?stage=wall">Apply Manually</a><a class="button" href="${base}?stage=wall">Autofill with Resume</a><a class="button" href="${base}?stage=wall">Use My Last Application</a></div>`,
  );
}

// Node's built-in FormData parser handles multipart uploads without dependencies.
async function readPost(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024)
      throw new Error("Request exceeds the 10 MB fixture limit");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const type = req.headers["content-type"] || "";
  if (type.includes("application/json")) return JSON.parse(body.toString());
  const data = await new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": type },
    body,
  }).formData();
  const fields = {};
  for (const [key, value] of data) {
    const entry =
      typeof value === "string"
        ? value
        : { filename: value.name, size: value.size, type: value.type };
    if (Object.hasOwn(fields, key))
      fields[key] = Array.isArray(fields[key])
        ? [...fields[key], entry]
        : [fields[key], entry];
    else
      Object.defineProperty(fields, key, {
        value: entry,
        enumerable: true,
        writable: true,
      });
  }
  return fields;
}
function logPost(path, fields) {
  const line =
    JSON.stringify(
      { time: new Date().toISOString(), method: "POST", path, fields },
      (key, value) => (/password/i.test(key) ? "[redacted]" : value),
    ) + "\n";
  appendFileSync(
    process.env.NESTOR_FIXTURE_SUBMISSIONS_LOG ||
      new URL("submissions.log", import.meta.url),
    line,
  );
  process.stdout.write(line);
}
function missing(fields, names) {
  return names.some(
    (name) => typeof fields[name] !== "string" || !fields[name].trim(),
  );
}
function hasResume(fields) {
  return fields.resume && fields.resume.filename && fields.resume.size > 0;
}

const scale = createScaleRouter({
  dispatch: (req, res) => server.emit("request", req, res),
  port: () => server.address().port,
});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  const send = (status, body, type = "text/html; charset=utf-8") => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    res.end(body);
  };
  const json = (status, body) =>
    send(status, JSON.stringify(body), "application/json");
  const token = /(?:^|;\s*)fixture_session=([^;]+)/.exec(
    req.headers.cookie || "",
  )?.[1];
  const session = sessions.get(token);
  const authboardSignedIn = /(?:^|;\s*)fixture_authboard=1(?:;|$)/.test(
    req.headers.cookie || "",
  );
  try {
    if (await handleRemoteSearch(req, res, url, { send, readPost, logPost }))
      return;
    if (handlePermitFit(req, res, url, { send })) return;
    if (await scale.handle(req, res, url)) return;
    if (await handleHandoverOptions(req, res, url, { send, readPost, logPost }))
      return;
    // A site whose protection refuses automated browsers: its listings
    // read, its application pages answer 403 with a block notice.
    const blocked = /^\/blocked-site\/(jobs|apply)\/([12])$/u.exec(path);
    if (blocked) {
      if (blocked[1] === "jobs")
        return send(
          200,
          page(
            "blocked-site",
            `Support Engineer ${blocked[2]}`,
            `<p>Shield Gate Replica · Remote, Worldwide</p><p>Help fictional customers.</p><a href="/blocked-site/apply/${blocked[2]}">Apply</a>`,
          ),
        );
      return send(
        403,
        "<!doctype html><title>Access denied</title><h1>You have been blocked.</h1><p>Automated requests are not allowed.</p>",
      );
    }
    if (
      await handleRememberedQuestions(req, res, url, {
        send,
        readPost,
        logPost,
      })
    )
      return;
    if (
      await handleRealUploadShapes(req, res, url, { send, readPost, logPost })
    )
      return;
    if (await handleFillChores(req, res, url, { send, readPost, logPost }))
      return;
    if (await handleStepsShape(req, res, url, { send, readPost, logPost }))
      return;
    if (handlePersonalClaims(req, res, url, { send })) return;
    if (await handleUploadRepair(req, res, url, { send, readPost, logPost }))
      return;
    if (await handleMoreSites(req, res, url, { send, readPost, logPost }))
      return;
    if (req.method === "POST") {
      const fields = await readPost(req);
      // Local sign-in credentials are never part of fixture submission logs.
      if (
        path !== "/authboard/signin" &&
        !/^\/workday\/(?:account|verify)\//u.test(path)
      )
        logPost(path, fields);
      if (path === "/authboard/signin") {
        if (missing(fields, ["email", "password"])) {
          return send(
            400,
            page(
              "authboard",
              "Sign in to see jobs",
              '<h1>Sign in to see jobs</h1><p>Enter a made-up email and password to continue this local test.</p><p class="error" role="alert">Both fields are required.</p>' +
                form(
                  "/authboard/signin",
                  input("email", "Email", "email") +
                    input("password", "Password", "password") +
                    "<button>Sign in</button>",
                ),
            ),
          );
        }
        res.writeHead(303, {
          Location: "/authboard/",
          "Set-Cookie":
            "fixture_authboard=1; HttpOnly; SameSite=Lax; Path=/authboard",
        });
        return res.end();
      }
      const account =
        /^\/workday\/account\/(register|signin)\/([1-9]\d*)$/.exec(path);
      if (account) {
        const [, action, id] = account;
        const job = jobs.find((item) => item.id === id);
        if (!job)
          return send(404, page("", "Not found", "<h1>Page not found</h1>"));
        let error = "";
        if (missing(fields, ["email", "password"]))
          error = "Email and password are required.";
        else if (action === "register") {
          if (
            fields.password !== fields.verifyPassword ||
            fields.agree !== "yes"
          )
            error = "Passwords must match and you must agree.";
          else if (accounts.has(fields.email))
            error = "This account already exists. Please sign in.";
          else {
            const salt = randomBytes(16).toString("hex");
            accounts.set(fields.email, {
              salt,
              hash: scryptSync(fields.password, salt, 32),
              mfa: fields.enableMfa === "yes",
            });
          }
        } else {
          const saved = accounts.get(fields.email);
          if (
            !saved ||
            !timingSafeEqual(
              saved.hash,
              scryptSync(fields.password, saved.salt, 32),
            )
          )
            error = "Email or password did not match.";
        }
        if (error) return send(400, workday(job, action, null, error));
        if (accounts.get(fields.email).mfa) {
          const pending = randomBytes(24).toString("hex");
          pendingFactors.set(pending, { email: fields.email });
          res.writeHead(303, {
            Location: `/workday/verify/${id}`,
            "Set-Cookie": `fixture_mfa=${pending}; HttpOnly; SameSite=Lax; Path=/workday`,
          });
          return res.end();
        }
        const newToken = randomBytes(24).toString("hex");
        sessions.set(newToken, { email: fields.email, drafts: new Map() });
        res.writeHead(303, {
          Location: `/workday/apply/${id}?stage=application`,
          "Set-Cookie": `fixture_session=${newToken}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/workday`,
        });
        return res.end();
      }
      const verify = /^\/workday\/verify\/([1-9]\d*)$/u.exec(path);
      if (verify) {
        const job = jobs.find((item) => item.id === verify[1]);
        const pendingToken = /(?:^|;\s*)fixture_mfa=([^;]+)/u.exec(
          req.headers.cookie || "",
        )?.[1];
        const pending = pendingFactors.get(pendingToken);
        if (!job || !pending) return send(401, "Sign in to continue.");
        if (fields.code !== "482917")
          return send(
            400,
            workdayVerification(job, "That code did not match."),
          );
        pendingFactors.delete(pendingToken);
        const newToken = randomBytes(24).toString("hex");
        sessions.set(newToken, { email: pending.email, drafts: new Map() });
        res.writeHead(303, {
          Location: `/workday/apply/${job.id}?stage=application`,
          "Set-Cookie": `fixture_session=${newToken}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/workday`,
        });
        return res.end();
      }
      if (path === "/workday/api/save") {
        if (!session) return json(401, { error: "Please sign in." });
        if (!jobs.some((job) => job.id === fields.jobId))
          return json(400, { error: "Unknown job." });
        session.drafts.set(fields.jobId, fields);
        return json(200, { saved: true });
      }
      if (path === "/gatekeeper/api/autosave")
        return json(200, { saved: true });
      if (path === "/gatekeeper/api/submit") {
        if (
          !jobs.some((job) => job.id === fields.jobId) ||
          missing(fields, ["name", "email", "phone"]) ||
          !hasResume(fields)
        )
          return json(400, {
            error: "Complete the required fields and attach a resume.",
          });
        return json(200, { message: confirmation });
      }
      const match =
        /^\/(employer-a|lever|greenhouse|workday)\/apply\/([1-9]\d*)$/.exec(
          path,
        );
      if (match) {
        const site = match[1] === "employer-a" ? "board" : match[1];
        const job = jobs.find((item) => item.id === match[2]);
        if (!job)
          return send(404, page("", "Not found", "<h1>Page not found</h1>"));
        if (site === "workday" && !session)
          return send(401, workday(job, "wall"));
        if (site === "lever" && job.id === "1" && fields.human !== "yes")
          return send(
            422,
            application(site, job, "Please verify you are human"),
          );
        const required = {
          board: ["name", "email", "phone", "certify"],
          lever: [
            "location",
            "name",
            "email",
            "phone",
            "currentLocation",
            ...(job.id === "8"
              ? ["certify", "privacy", "terms"]
              : ["backgroundConsent"]),
          ],
          greenhouse: [
            "firstName",
            "lastName",
            "email",
            "phone",
            "experience",
            "authorized",
            "sponsorship",
            "motivation",
          ],
          workday: [
            "source",
            "firstName",
            "lastName",
            "email",
            "phone",
            "address",
            "city",
            "postalCode",
            "country",
            "authorized",
            "sponsorship",
            "remote",
            "notice",
            "strengths",
            "terms",
          ],
        }[site];
        const requiredAttachments =
          site === "greenhouse"
            ? job.id === "7"
              ? ["portfolio", "transcript"]
              : job.id === "8"
                ? ["coverLetterFile"]
                : []
            : [];
        const missingAttachment = requiredAttachments.some(
          (name) => !fields[name]?.filename || !(fields[name].size > 0),
        );
        if (
          missing(fields, required) ||
          !hasResume(fields) ||
          missingAttachment
        )
          return send(
            422,
            page(
              site,
              "Incomplete application",
              "<h1>Complete the required fields and attach a resume.</h1><p>Use Back to return to your application.</p>",
            ),
          );
        return send(
          200,
          page(
            site,
            "Application received",
            `<h1>${confirmation}</h1><p>This fictional application stays on your computer.</p>`,
          ),
        );
      }
      return send(404, "Unknown POST endpoint");
    }
    if (req.method !== "GET") return send(405, "Method not allowed");
    if (path === "/")
      return send(
        200,
        page(
          "",
          "Local replica job sites",
          `<h1>Local replica job sites</h1><p>Choose a listing URL as a Job Finder source.</p><ul>${Object.entries(
            sites,
          )
            .map(
              ([site, name]) =>
                `<li><a href="/${site}/">${name} /${site}/</a></li>`,
            )
            .join(
              "",
            )}${moreSites.map((site) => `<li><a href="/${site.slug}/">${escape(site.name)} /${site.slug}/</a> — ${site.count} jobs. ${escape(site.description)}</li>`).join("")}</ul>`,
        ),
      );
    if (path.startsWith("/assets/")) {
      const name = path.slice("/assets/".length);
      if (assets.has(name))
        return send(
          200,
          assets.get(name),
          name.endsWith(".css") ? "text/css" : "text/javascript",
        );
    }
    if (path === "/authboard/signout") {
      res.writeHead(303, {
        Location: "/authboard/",
        "Set-Cookie":
          "fixture_authboard=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/authboard",
      });
      return res.end();
    }
    if (path.startsWith("/authboard/") && !authboardSignedIn) {
      return send(
        401,
        page(
          "authboard",
          "Sign in to see jobs",
          "<h1>Sign in to see jobs</h1><p>Sign in to view these job listings. Use a made-up email and password for this local test.</p>" +
            form(
              "/authboard/signin",
              input("email", "Email", "email") +
                input("password", "Password", "password") +
                "<button>Sign in</button>",
            ),
        ),
      );
    }
    const verification = /^\/workday\/verify\/([1-9]\d*)$/u.exec(path);
    if (verification) {
      const job = jobs.find((item) => item.id === verification[1]);
      const pendingToken = /(?:^|;\s*)fixture_mfa=([^;]+)/u.exec(
        req.headers.cookie || "",
      )?.[1];
      return job && pendingFactors.has(pendingToken)
        ? send(200, workdayVerification(job))
        : send(401, "Sign in to continue.");
    }
    const list =
      /^\/(authboard|board|lever|greenhouse|workday|gatekeeper|empty)\/?$/.exec(
        path,
      );
    if (list) return send(200, listing(list[1]));
    const match =
      /^\/(authboard|board|employer-a|lever|greenhouse|workday|gatekeeper)\/(jobs|apply|security)\/([1-9]\d*)$/.exec(
        path,
      );
    if (!match)
      return send(404, page("", "Not found", "<h1>Page not found</h1>"));
    const [, prefix, kind, id] = match;
    const site = prefix === "employer-a" ? "board" : prefix;
    const job = jobs.find((item) => item.id === id);
    if (!job)
      return send(404, page("", "Not found", "<h1>Page not found</h1>"));
    if (kind === "security" && site === "gatekeeper") {
      if (
        /(?:^|;\s*)fixture_gatekeeper_verified=1(?:;|$)/u.test(
          req.headers.cookie || "",
        )
      ) {
        res.writeHead(302, { Location: `/gatekeeper/jobs/${id}` });
        return res.end();
      }
      return send(
        200,
        page(
          site,
          "Just a moment...",
          '<h1>Just a moment...</h1><p>Performing security verification</p><span class="spinner" aria-label="Verifying"></span>',
          `<script>setTimeout(() => { document.cookie = 'fixture_gatekeeper_verified=1; Path=/gatekeeper; SameSite=Lax; Max-Age=3600'; location.replace('/gatekeeper/jobs/${id}'); }, 8000);</script>`,
        ),
      );
    }
    if (kind === "jobs") return send(200, detail(site, job));
    if (kind === "apply")
      return send(
        200,
        site === "workday"
          ? workday(job, url.searchParams.get("stage"), session)
          : application(site, job),
      );
    return send(404, "Page not found");
  } catch (error) {
    console.error(error.message);
    return send(400, "The local fixture could not read this request.");
  }
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(Number(process.env.PORT || 47950), "127.0.0.1", () => {
  console.error(
    `Local replica job sites: http://127.0.0.1:${server.address().port}/`,
  );
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    scale.close();
    server.close(() => process.exit(0));
  });
