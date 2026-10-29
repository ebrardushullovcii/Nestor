import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Script } from "node:vm";
import { moreSites } from "./sites/catalog.mjs";

const confirmation = "Thank you! Your application has been received.";
const links = (html) => [
  ...html.matchAll(/href="([^"]+)" data-job-id="(\d+)"/g),
];
const titles = (html) => links(html).map(([, , id]) => id);

export async function checkMore({ request, application, index }) {
  assert.equal(moreSites.length, 15);
  let postCount = 0,
    jobCount = 0,
    pageCount = 0,
    pacedRequests = 0;
  const receipts = [];
  async function get(path, status = 200, options = {}) {
    if (path.startsWith("/pacer/") && ++pacedRequests % 6 === 0)
      await delay(3100);
    return request(path, options, status);
  }
  async function post(path, data, status = 200, json = false) {
    postCount++;
    return get(path, status, {
      method: "POST",
      body: data,
      ...(json ? { headers: { Accept: "application/json" } } : {}),
      ...(status === 303 ? { redirect: "manual" } : {}),
    });
  }
  function answers(site) {
    const data = application({
      country: "Germany",
      phoneCode: "+49",
      authorized: "Yes",
      sponsorship: "No",
      relocation: "No",
      over18: "Yes",
      startDate: "2027-01-12",
      availability: "2027-01-08",
      salary: "65000",
      currency: "EUR",
      notice: "Two weeks",
      skills: "Analysis",
      onsiteDays: "Tuesday",
      analysisYears: "3",
      coordinationYears: "2",
      portfolio: "https://portfolio.synthetic.example/work",
      linkedin: "https://profile.synthetic.example/candidate",
      github: "https://code.synthetic.example/projects",
      motivation:
        "I enjoy helping fictional teams with thoughtful design, clear analysis and useful communication.",
      certify: "yes",
      privacy: "yes",
      backgroundConsent: "yes",
    });
    if (site.style === "paste") {
      data.delete("resume");
      data.set(
        "resumeText",
        "Synthetic candidate with experience in teaching and marketing.",
      );
    }
    if (site.cover)
      data.set(
        "coverLetterFile",
        new Blob(["Fictional candidate cover letter."], { type: "text/plain" }),
        "cover-letter.txt",
      );
    if (site.groups.includes("history"))
      for (const [key, value] of Object.entries({
        work1Title: "Analyst",
        work1Company: "Fictional Thimble Workshop",
        work1From: "2020-03",
        work1To: "2024-05",
        work2Title: "Planner",
        work2Company: "Fictional Cuff Workshop",
        work2From: "2024-06",
      }))
        data.set(key, value);
    if (site.groups.includes("education"))
      for (const [key, value] of Object.entries({
        education1Institution: "Fictional Fern Academy",
        education1Qualification: "Synthetic diploma",
        education1Year: "2020",
        education2Institution: "Fictional Button Academy",
        education2Qualification: "Synthetic certificate",
        education2Year: "2021",
      }))
        data.set(key, value);
    return data;
  }
  for (const site of moreSites) {
    assert.ok(
      index.includes(`href="/${site.slug}/"`),
      `${site.slug}: missing index link`,
    );
    assert.ok(index.includes(site.description));
    let path = `/${site.slug}/`;
    const found = new Set();
    let first;
    while (path) {
      const { body } = await get(path);
      if (!first) first = body;
      pageCount++;
      const jobs = links(body);
      assert.ok(jobs.length > 0 && jobs.length <= 20, `${path}: page size`);
      for (const [, , id] of jobs) {
        assert.ok(!found.has(id), `${path}: repeated job`);
        found.add(id);
      }
      const next =
        site.pagination === "offset"
          ? /href="([^"]+)" data-load-more/.exec(body)
          : /href="([^"]+)" rel="next"/.exec(body);
      path = next ? next[1].replaceAll("&amp;", "&") : "";
    }
    assert.equal(found.size, site.count, `${site.slug}: pagination lost jobs`);
    jobCount += found.size;
    assert.ok(first.includes("data-cookie-banner"));
    assert.ok(first.includes(`data-total="${site.count}"`));
    assert.equal(
      (await get(`/${site.slug}/`)).body,
      first,
      `${site.slug}: unstable listing`,
    );
    const detail = (await get(`/${site.slug}/jobs/1`)).body;
    assert.ok(detail.includes(`href="/${site.slug}/apply/1"`));
    const structured = JSON.parse(
      /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(detail)[1],
    );
    assert.equal(structured["@type"], "JobPosting");
    assert.ok(structured.identifier.value);
    const started = Date.now();
    const plain = (await get(`/${site.slug}/jobs/2`)).body;
    if (site.slow)
      assert.ok(
        Date.now() - started >= 7800,
        "Slow fixture must really delay its response",
      );
    assert.ok(!plain.includes("application/ld+json"));
    const closed = (
      await get(`/${site.slug}/jobs/30`, site.count < 30 ? 404 : 200)
    ).body;
    if (site.count >= 30) {
      assert.ok(
        closed.includes("This job is no longer accepting applications."),
      );
      await get(`/${site.slug}/apply/30`, 410);
    }
    let form = (await get(`/${site.slug}/apply/1`)).body;
    if (site.guest) {
      assert.ok(form.includes("Continue as guest"));
      form = (await get(`/${site.slug}/apply/1?guest=1`)).body;
      assert.ok(form.includes("Keep working"));
    }
    if (site.iframe) {
      assert.ok(form.includes('<iframe title="Application'));
      form = (await get(`/${site.slug}/apply/1?embedded=1`)).body;
    }
    assert.ok(form.includes("Apply with a profile from another site"));
    assert.equal([...form.matchAll(/data-step="/g)].length, site.steps || 1);
    assert.match(form, /name="marketing"[^>]*value="yes"/);
    assert.doesNotMatch(form, /name="marketing"[^>]*(checked|required)/);
    if (site.steps) assert.ok(form.includes("Review and send"));
    if (site.cover) assert.match(form, /name="coverLetterFile"[^>]*required/);
    if (site.style === "parse")
      assert.ok(form.includes("Parse resume and prefill"));
    const incomplete = await post(
      `/${site.slug}/apply/1`,
      new FormData(),
      422,
      true,
    );
    assert.ok(JSON.parse(incomplete.body).errors.name);
    const complete = await post(`/${site.slug}/apply/1`, answers(site));
    assert.ok(
      complete.body.includes(confirmation),
      `${site.slug}: missing receipt`,
    );
    assert.match(
      complete.body,
      new RegExp(`Reference: ${site.slug.toUpperCase()}-1-`),
    );
    receipts.push(`/${site.slug}/apply/1`);
  }
  assert.equal(jobCount, 1234);
  for (const slug of ["atlas", "ripple"]) {
    const filtered = (
      await get(`/${slug}/?q=designer&location=remote&sort=oldest`)
    ).body;
    assert.ok(links(filtered).length > 0);
    const dates = [...filtered.matchAll(/<time datetime="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(dates, [...dates].sort());
    for (const text of [
      ...filtered.matchAll(/class="job-location">([^<]+)/g),
    ].map((match) => match[1]))
      assert.match(text, /remote/i);
    const paginated = (
      await get(`/${slug}/?q=fictional&location=remote&sort=oldest`)
    ).body;
    assert.equal(links(paginated).length, 20);
    const second = (
      await get(
        `/${slug}/?q=fictional&location=remote&sort=oldest&${slug === "atlas" ? "page=2" : "offset=20"}`,
      )
    ).body;
    assert.ok(links(second).length > 0);
    assert.ok(titles(second).every((id) => !titles(paginated).includes(id)));
    assert.equal(
      links((await get(`/${slug}/?q=unfindable-fixture-token`)).body).length,
      0,
    );
  }
  const dept = (await get("/brindle/?department=Healthcare")).body;
  assert.equal(links(dept).length, 12);
  assert.ok(dept.includes('data-matches="12"'));
  const duplicateA = (await get("/atlas/jobs/1")).body,
    duplicateB = (await get("/ripple/jobs/1")).body;
  for (const html of [duplicateA, duplicateB]) {
    assert.ok(html.includes("SHARED-ACORN-0001"));
    assert.ok(html.includes("Senior Product Designer"));
    assert.ok(html.includes("Acorn Hushmeadow Workshop"));
  }
  const logoCard = (await get("/ripple/?q=Logistics&sort=title")).body;
  // Find the initials-only card independently of the current sort/page.
  const logoDetail = (await get("/ripple/jobs/7")).body;
  const logoTitle = /<h1>(.*?)<\/h1>/.exec(logoDetail)[1];
  const logoListing = (
    await get(`/ripple/?q=${encodeURIComponent(logoTitle)}&sort=newest`)
  ).body;
  const card =
    /<article class="job"[^>]*>(?:(?!<\/article>).)*data-job-id="7"(?:(?!<\/article>).)*<\/article>/s.exec(
      logoListing,
    )[0];
  assert.ok(card.includes('role="img"'));
  assert.ok(!card.includes('<p class="company">'));
  assert.ok(logoDetail.includes('<p class="company">'));
  assert.ok(logoCard.includes('class="tags"'));
  for (const route of [
    "category/berlin",
    "companies",
    "blog/interview-tips",
    "salary-guide",
  ]) {
    const body = (await get(`/atlas/${route}`)).body;
    assert.equal(links(body).length, 0);
    assert.ok(!body.includes("JobPosting"));
    assert.ok(!body.includes("/apply/"));
  }
  assert.ok(
    (await get("/folio/jobs/2")).body.includes("jobs@foliofern.example"),
  );
  await get("/folio/apply/2", 410);
  const handoff = await get("/ripple/apply/3", 303, { redirect: "manual" });
  assert.equal(handoff.response.headers.get("location"), "/cedar-ats/apply/3");
  assert.ok(
    (await get(handoff.response.headers.get("location"))).body.includes(
      "Continue as guest",
    ),
  );
  await post(
    "/cedar-ats/account/1",
    new URLSearchParams({ email: "bad", password: "short" }),
    422,
  );
  const account = await post(
    "/cedar-ats/account/1",
    new URLSearchParams({
      email: "profile@example.invalid",
      password: "synthetic-password-only",
    }),
    303,
  );
  assert.equal(
    account.response.headers.get("location"),
    "/cedar-ats/apply/1?guest=1&profile=1",
  );
  const folio = moreSites.find((site) => site.slug === "folio");
  const badFolio = answers(folio);
  badFolio.delete("coverLetterFile");
  badFolio.set("portfolio", "not-a-url");
  badFolio.set("motivation", "x".repeat(601));
  const folioErrors = JSON.parse(
    (await post("/folio/apply/1", badFolio, 422, true)).body,
  ).errors;
  for (const name of ["coverLetterFile", "portfolio", "motivation"])
    assert.ok(folioErrors[name]);
  const badSalary = answers(
    moreSites.find((site) => site.slug === "ledgerleaf"),
  );
  badSalary.set("salary", "-1");
  badSalary.set("currency", "invalid");
  badSalary.set("work1To", "2019-01");
  badSalary.set("authorized", "Maybe");
  badSalary.set("privacy", "no");
  const salaryErrors = JSON.parse(
    (await post("/ledgerleaf/apply/1", badSalary, 422, true)).body,
  ).errors;
  for (const name of ["salary", "currency", "work1To", "authorized", "privacy"])
    assert.ok(salaryErrors[name]);
  const badDates = answers(
    moreSites.find((site) => site.slug === "parcelpath"),
  );
  badDates.set("startDate", "2027-02-30");
  badDates.set("country", "Not a country");
  badDates.set("phoneCode", "+000");
  const dateErrors = JSON.parse(
    (await post("/parcelpath/apply/1", badDates, 422, true)).body,
  ).errors;
  for (const name of ["startDate", "country", "phoneCode"])
    assert.ok(dateErrors[name]);
  const htmlData = answers(moreSites[0]);
  htmlData.set("name", '<script>alert("fixture")</script>');
  htmlData.set("email", "invalid");
  const htmlErrors = (await post("/atlas/apply/1", htmlData, 422)).body;
  assert.ok(htmlErrors.includes('data-error="email"'));
  assert.ok(htmlErrors.includes("&lt;script&gt;"));
  assert.ok(!htmlErrors.includes('<script>alert("fixture")</script>'));
  await post("/atlas/apply/30", answers(moreSites[0]), 410);
  await get("/atlas/jobs/9999", 404);
  await get("/atlas/jobs/1/extra", 404);
  await get("/atlas/?page=invalid&sort=invalid&location=%3Cscript%3E");
  await delay(3100);
  for (let index = 0; index < 8; index++) await request("/pacer/");
  const limited = await request("/pacer/", {}, 429);
  assert.match(limited.response.headers.get("retry-after"), /^[12]$/);
  await delay(Number(limited.response.headers.get("retry-after")) * 1000 + 100);
  await request("/pacer/");
  new Script((await get("/replica-assets/client.js")).body);
  await get("/replica-assets/styles.css");
  return { postCount, receipts, jobCount, pageCount };
}

export function checkMoreLogs(posts, result) {
  for (const path of result.receipts) {
    const post = posts.filter((entry) => entry.path === path).at(-1);
    // Additional failed attempts can follow the receipt, so find the completed payload.
    const complete = posts.find(
      (entry) =>
        entry.path === path &&
        entry.fields.name === "Fixture Candidate" &&
        entry.fields.privacy === "yes" &&
        entry.fields.currency === "EUR",
    );
    assert.ok(post && complete, `${path}: missing logged submission`);
    assert.equal(complete.fields.marketing, undefined);
    if (complete.fields.resume?.filename)
      assert.deepEqual(Object.keys(complete.fields.resume).sort(), [
        "filename",
        "size",
        "type",
      ]);
    else
      assert.ok(complete.fields.resumeText.startsWith("Synthetic candidate"));
  }
  for (const post of posts.filter((entry) =>
    entry.path.startsWith("/cedar-ats/account/"),
  ))
    assert.equal(post.fields.password, "[redacted]");
  console.log(
    `PASS: 15 new sites; ${result.jobCount} jobs across ${result.pageCount} listing pages; 15 confirmations and POST logs; filters, duplicates, closed/email-only jobs, local redirect, iframe markup, validation, slow responses and 429 recovery.`,
  );
}
