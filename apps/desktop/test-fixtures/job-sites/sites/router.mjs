import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { moreSites } from "./catalog.mjs";
import { createCatalog } from "./data.mjs";
import { validateApplication, escape } from "./forms.mjs";
import { page, listing, detail, applyPage, editorial } from "./pages.mjs";

export { moreSites };
const catalog = createCatalog(moreSites);
const assets = new Map(
  ["client.js", "styles.css"].map((name) => [
    name,
    readFileSync(new URL(name, import.meta.url)),
  ]),
);
const rateRequests = new Map();
const profiles = new Map();
const confirmation = "Thank you! Your application has been received.";

// Return false for existing routes so their behavior remains untouched.
export async function handleMoreSites(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname === "/api/non-user-graphql" && req.method === "POST") {
    const payload = await readPost(req);
    logPost(url.pathname, payload);
    const target = new URL(`http://${req.headers.host}`);
    target.hostname = "localhost";
    target.pathname = "/";
    send(
      200,
      JSON.stringify({
        data: {
          fileUploadHandle: {
            url: target.href,
            fields: {
              acl: "private",
              bucket: "replica-files",
              Policy: "synthetic-policy",
              "X-Amz-Signature": "synthetic-signature",
            },
          },
        },
      }),
      "application/json",
    );
    return true;
  }
  if (
    url.pathname === "/" &&
    req.method === "POST" &&
    /^localhost:/iu.test(req.headers.host ?? "")
  ) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "POST") send(405, "Method not allowed");
    else {
      const files = await readPost(req);
      logPost(url.pathname, files);
      send(200, JSON.stringify({ uploaded: true }), "application/json");
    }
    return true;
  }
  if (url.pathname.startsWith("/replica-assets/")) {
    const name = url.pathname.slice("/replica-assets/".length);
    if (req.method !== "GET") send(405, "Method not allowed");
    else if (assets.has(name))
      send(
        200,
        assets.get(name),
        name.endsWith(".css") ? "text/css" : "text/javascript",
      );
    else send(404, "Asset not found");
    return true;
  }
  const [, slug, kind, id] = url.pathname.split("/");
  const site = moreSites.find((entry) => entry.slug === slug);
  if (!site) return false;
  const jobs = catalog.get(slug);
  if (site.rateLimit) {
    const now = Date.now();
    const key = req.socket.remoteAddress;
    const state = rateRequests.get(key) || { requests: [], until: 0 };
    state.requests = state.requests.filter((time) => now - time < 3000);
    if (state.until > now || state.requests.length >= 8) {
      if (state.until <= now) {
        state.until = now + 2000;
        state.requests = [];
      }
      rateRequests.set(key, state);
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((state.until - now) / 1000))),
      );
      send(
        429,
        page(
          site,
          "Please slow down",
          "<h1>Too many requests</h1><p>Please wait a few seconds, then try again. Your application has not been sent.</p>",
        ),
      );
      return true;
    }
    state.requests.push(now);
    rateRequests.set(key, state);
  }
  if (!["GET", "POST"].includes(req.method)) {
    send(405, "Method not allowed");
    return true;
  }
  if (
    site.slow &&
    req.method === "GET" &&
    ["", "jobs", "apply"].includes(kind || "")
  )
    await delay(kind === "jobs" ? (id === "2" ? 8000 : 5000) : 3000);
  const job = jobs.find((entry) => entry.id === id);
  const notFound = () =>
    send(404, page(site, "Not found", "<h1>Page not found</h1>"));
  const redirect = (location) => {
    res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
    res.end();
  };
  if (req.method === "POST") {
    const values = await readPost(req);
    logPost(url.pathname, values);
    if (
      !job ||
      !new RegExp(`^/${slug}/(apply|account)/[1-9]\\d*$`).test(url.pathname)
    ) {
      notFound();
      return true;
    }
    if (kind === "account" && site.guest) {
      if (
        typeof values.email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) ||
        typeof values.password !== "string" ||
        values.password.length < 8
      )
        send(
          422,
          page(
            site,
            "Incomplete profile",
            '<h1>Profile not created</h1><p class="error" role="alert">Enter a valid email and a password of at least eight characters.</p><a href="/cedar-ats/apply/' +
              job.id +
              '">Return to the application options</a>',
          ),
        );
      else {
        profiles.set(values.email, { email: values.email });
        redirect(`/${slug}/apply/${id}?guest=1&profile=1`);
      }
      return true;
    }
    if (kind !== "apply") {
      notFound();
      return true;
    }
    if (job.closed || job.emailOnly) {
      send(
        410,
        page(
          site,
          "Unavailable",
          `<h1>${job.closed ? "This job is no longer accepting applications." : "This job accepts applications by email only."}</h1>`,
        ),
      );
      return true;
    }
    if (slug === "ripple" && id === "3") {
      redirect("/cedar-ats/apply/3");
      return true;
    }
    const errors = validateApplication(site, values);
    const wantsJson = (req.headers.accept || "").includes("application/json");
    if (Object.keys(errors).length)
      send(
        422,
        wantsJson
          ? JSON.stringify({ errors })
          : applyPage(
              site,
              job,
              new URLSearchParams("guest=1&embedded=1"),
              values,
              errors,
            ),
        wantsJson ? "application/json" : "text/html; charset=utf-8",
      );
    else {
      const reference = `${slug.toUpperCase()}-${id}-${Date.now().toString(36).toUpperCase()}`;
      send(
        200,
        wantsJson
          ? JSON.stringify({ message: confirmation, reference })
          : page(
              site,
              "Application received",
              `<h1 role="status">${confirmation}</h1><p>Reference: ${escape(reference)}</p><p>This fictional application stays on your computer.</p>`,
            ),
        wantsJson ? "application/json" : "text/html; charset=utf-8",
      );
    }
    return true;
  }
  if (url.pathname === `/${slug}` || url.pathname === `/${slug}/`)
    send(200, listing(site, jobs, url.searchParams));
  else if (
    [
      `/${slug}/category/berlin`,
      `/${slug}/companies`,
      `/${slug}/blog/interview-tips`,
      `/${slug}/salary-guide`,
    ].includes(url.pathname)
  )
    send(200, editorial(site, url.pathname));
  else if (
    !job ||
    !new RegExp(`^/${slug}/(jobs|apply)/[1-9]\\d*$`).test(url.pathname)
  )
    notFound();
  else if (kind === "jobs")
    send(200, detail(site, job, `http://127.0.0.1:${res.socket.localPort}`));
  else if (job.closed || job.emailOnly)
    send(
      410,
      page(
        site,
        "Unavailable",
        `<h1>${job.closed ? "This job is no longer accepting applications." : "This job accepts applications by email only."}</h1>`,
      ),
    );
  else if (slug === "ripple" && id === "3") redirect("/cedar-ats/apply/3");
  else send(200, applyPage(site, job, url.searchParams));
  return true;
}
