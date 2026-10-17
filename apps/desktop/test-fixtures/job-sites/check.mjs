import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Script } from "node:vm";
import { checkMore, checkMoreLogs } from "./check-more.mjs";

const confirmation = "Thank you! Your application has been received.";
const directory = new URL("./", import.meta.url);
const submissionsLogPath = join(
  tmpdir(),
  `nestor-job-sites-check-${process.pid}.log`,
);
const server = spawn(
  process.execPath,
  [new URL("serve.mjs", directory).pathname],
  {
    env: {
      ...process.env,
      PORT: "0",
      NESTOR_FIXTURE_SUBMISSIONS_LOG: submissionsLogPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const exited = once(server, "exit");
const posts = [];
const output = createInterface({ input: server.stdout });
output.on("line", (line) => posts.push(JSON.parse(line)));
let cookie = "";
let requestCount = 0;

try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Server startup timed out")),
      10000,
    );
    const errors = createInterface({ input: server.stderr });
    errors.on("line", (line) => {
      const match =
        /Local replica job sites: (http:\/\/127\.0\.0\.1:\d+)\//.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      } else console.error(line);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early: ${code}`));
    });
  });
  async function request(path, options = {}, expectedStatus = 200) {
    const response = await fetch(base + path, {
      ...options,
      signal: AbortSignal.timeout(10000),
      headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const body = await response.text();
    assert.equal(
      response.status,
      expectedStatus,
      `${path}: ${body.slice(0, 150)}`,
    );
    requestCount++;
    return { response, body };
  }
  function application(extra = {}) {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      name: "Fixture Candidate",
      firstName: "Fixture",
      lastName: "Candidate",
      email: "candidate@example.invalid",
      phone: "000-000-0000",
      ...extra,
    }))
      data.set(key, value);
    data.set(
      "resume",
      new Blob(["Synthetic resume. Fictional software developer."], {
        type: "text/plain",
      }),
      "synthetic-resume.txt",
    );
    return data;
  }
  async function submit(path, data, expectedStatus = 200) {
    return request(path, { method: "POST", body: data }, expectedStatus);
  }

  const index = (await request("/")).body;
  for (const site of [
    "board",
    "lever",
    "greenhouse",
    "workday",
    "gatekeeper",
  ]) {
    assert.ok(index.includes(`href="/${site}/"`));
    const listing = (await request(`/${site}/`)).body;
    const links = [...listing.matchAll(/href="([^"]+)" data-job-id="(\d+)"/g)];
    assert.ok(links.length === 10, `${site}: expected 10 jobs`);
    for (const [, href, id] of links) {
      if (site === "gatekeeper")
        assert.ok(
          (await request(href)).body.includes(
            `content="8;url=/gatekeeper/jobs/${id}"`,
          ),
        );
      const job = (await request(`/${site}/jobs/${id}`)).body;
      const apply = `/${site === "board" ? "employer-a" : site}/apply/${id}`;
      assert.ok(job.includes(`href="${apply}"`), `${site}: missing apply link`);
      if (site === "gatekeeper") assert.ok(job.includes('target="_blank"'));
      const form = (await request(apply)).body;
      assert.ok(form.includes(site === "workday" ? "Apply Manually" : "<form"));
      if (site === "workday") {
        for (const stage of ["wall", "register", "signin"])
          assert.ok(
            (await request(`${apply}?stage=${stage}`)).body.includes(
              stage === "signin" ? "Sign in" : "Create account",
            ),
          );
      }
    }
  }

  assert.ok(
    (
      await submit("/employer-a/apply/1", application({ certify: "yes" }))
    ).body.includes(confirmation),
  );
  const lever = {
    location: "Remote, Europe",
    currentLocation: "Cloud Harbor",
    backgroundConsent: "yes",
  };
  assert.ok(
    (await submit("/lever/apply/1", application(lever), 422)).body.includes(
      "Please verify you are human",
    ),
  );
  assert.ok(
    (
      await submit("/lever/apply/1", application({ ...lever, human: "yes" }))
    ).body.includes(confirmation),
  );
  assert.ok(
    (await submit("/lever/apply/2", application(lever))).body.includes(
      confirmation,
    ),
  );
  assert.ok(
    (
      await submit(
        "/greenhouse/apply/1",
        application({
          experience: "2–4",
          authorized: "Yes",
          sponsorship: "No",
          motivation: "I enjoy fictional software projects.",
        }),
      )
    ).body.includes(confirmation),
  );

  const routineForm = (await request("/lever/apply/8")).body;
  for (const name of ["certify", "privacy", "terms"])
    assert.match(routineForm, new RegExp(`name="${name}"[^>]*required`));
  assert.doesNotMatch(routineForm, /name="backgroundConsent"[^>]*required/);
  await submit("/lever/apply/8", application(lever), 422);
  const routine = application({
    location: lever.location,
    currentLocation: lever.currentLocation,
    certify: "yes",
    privacy: "yes",
    terms: "yes",
  });
  assert.ok(
    (await submit("/lever/apply/8", routine)).body.includes(confirmation),
  );

  const greenhouseAnswers = {
    experience: "2–4",
    authorized: "Yes",
    sponsorship: "No",
    motivation: "I enjoy fictional software projects.",
  };
  for (const [id, attachments] of [
    ["7", ["portfolio", "transcript"]],
    ["8", ["coverLetterFile"]],
  ]) {
    const path = `/greenhouse/apply/${id}`;
    const uploadForm = (await request(path)).body;
    for (const name of attachments)
      assert.match(uploadForm, new RegExp(`name="${name}"[^>]*required`));
    await submit(path, application(greenhouseAnswers), 422);
    const complete = application(greenhouseAnswers);
    for (const name of attachments)
      complete.set(
        name,
        new Blob([`Synthetic ${name} for a fictional candidate.`], {
          type: "text/plain",
        }),
        `${name}.txt`,
      );
    assert.ok((await submit(path, complete)).body.includes(confirmation));
  }

  await submit("/workday/apply/1", application(), 401);
  assert.ok(
    (await request("/workday/apply/1?stage=application")).body.includes(
      "Sign in / Create account",
    ),
  );
  const account = new URLSearchParams({
    email: "fixture@example.invalid",
    password: "synthetic-test-only",
    verifyPassword: "synthetic-test-only",
    agree: "yes",
  });
  const registration = await request(
    "/workday/account/register/1",
    { method: "POST", body: account, redirect: "manual" },
    303,
  );
  cookie = registration.response.headers.get("set-cookie").split(";")[0];
  for (let id = 1; id <= 10; id++) {
    const form = (await request(`/workday/apply/${id}?stage=application`)).body;
    for (const step of [
      "My Information",
      "My Experience",
      "Application Questions",
      "Review",
    ])
      assert.ok(form.includes(step));
    assert.equal([...form.matchAll(/data-step="/g)].length, 4);
  }
  const workday = {
    jobId: "1",
    source: "Job board",
    address: "1 Fictional Lane",
    city: "Cloud Harbor",
    postalCode: "00000",
    country: "Exampleland",
    authorized: "Yes",
    sponsorship: "No",
    remote: "Yes",
    notice: "Two weeks",
    strengths: "TypeScript",
    terms: "yes",
  };
  assert.equal(
    JSON.parse((await submit("/workday/api/save", application(workday))).body)
      .saved,
    true,
  );
  assert.ok(
    (await submit("/workday/apply/1", application(workday))).body.includes(
      confirmation,
    ),
  );
  const signIn = await request(
    "/workday/account/signin/1",
    { method: "POST", body: account, redirect: "manual" },
    303,
  );
  assert.ok(signIn.response.headers.get("set-cookie"));

  const autosave = await request("/gatekeeper/api/autosave", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId: "1",
      field: "name",
      value: "Fixture Candidate",
    }),
  });
  assert.equal(JSON.parse(autosave.body).saved, true);
  assert.equal(
    JSON.parse(
      (await submit("/gatekeeper/api/submit", application({ jobId: "1" })))
        .body,
    ).message,
    confirmation,
  );
  const clientScript = new Script((await request("/assets/client.js")).body);
  // The no-CAPTCHA variants must not throw from a handler that assumes the
  // human checkbox exists; the CAPTCHA variant still blocks until checked.
  for (const checked of [undefined, false, true]) {
    let onSubmit;
    let prevented = false;
    const error = { hidden: true };
    const leverForm = {
      elements: checked === undefined ? {} : { human: { checked } },
      addEventListener(type, handler) {
        if (type === "submit") onSubmit = handler;
      },
    };
    clientScript.runInNewContext({
      document: {
        querySelectorAll: () => [],
        querySelector: (selector) =>
          selector === 'form[data-site="lever"]' ? leverForm : null,
        getElementById: (id) => (id === "captcha-error" ? error : null),
      },
    });
    onSubmit?.({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, checked === false);
    if (checked !== undefined) assert.equal(error.hidden, checked);
  }
  assert.ok((await request("/assets/styles.css")).body.includes("opacity: 0"));
  await request("/missing", {}, 404);
  await request("/greenhouse/jobs/999", {}, 404);
  await request("/workday/apply/999", {}, 404);
  const more = await checkMore({ request, application, index });
  // Stop only this child, drain its output, then compare stdout with the on-disk log.
  server.kill("SIGTERM");
  await exited;
  const logged = (await readFile(submissionsLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    posts.length,
    18 + more.postCount,
    "Every POST must produce one stdout JSON line",
  );
  assert.deepEqual(
    logged.slice(-posts.length),
    posts,
    "File and stdout POST logs must match",
  );
  for (const post of posts.filter((post) => post.path.includes("/account/")))
    assert.equal(post.fields.password, "[redacted]");
  assert.equal(
    posts.find((post) => post.path === "/employer-a/apply/1").fields.resume
      .filename,
    "synthetic-resume.txt",
  );
  const routinePost = posts
    .filter((post) => post.path === "/lever/apply/8")
    .at(-1);
  assert.equal(routinePost.fields.backgroundConsent, undefined);
  for (const name of ["certify", "privacy", "terms"])
    assert.equal(routinePost.fields[name], "yes");
  const documentsPost = posts
    .filter((post) => post.path === "/greenhouse/apply/7")
    .at(-1);
  assert.equal(documentsPost.fields.portfolio.filename, "portfolio.txt");
  assert.equal(documentsPost.fields.transcript.filename, "transcript.txt");
  await rm(submissionsLogPath, { force: true });
  console.log(
    `PASS: 5 original listings, 50 jobs, 50 apply pages, account gate, CAPTCHA gate, uploads, autosaves, 5 confirmations and POST logs.`,
  );
  checkMoreLogs(posts, more);
  console.log(
    `PASS: ${requestCount} HTTP requests; ${posts.length} stdout/file POST log entries match; passwords redacted and uploads metadata only.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    await exited;
  }
  output.close();
}
