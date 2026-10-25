import http from "node:http";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const otherTitles = [
  "Registered Nurse",
  "Primary School Teacher",
  "Accountant",
  "Sales Representative",
  "Warehouse Associate",
  "Graphic Designer",
  "Chef",
];
const titles = [
  "Senior Backend Engineer",
  "Staff Platform Engineer",
  "API Engineer",
  "Software Engineer, Backend",
];
const jobs = [];
for (let employer = 0; employer < 540; employer++)
  for (let slot = 0; slot < 8; slot++) {
    const family =
      slot === 0 && employer % 9 < 3
        ? "backend"
        : slot === 0 && employer % 9 === 3
          ? "data"
          : "other";
    jobs.push({
      id: `company-${employer}-role-${slot}`,
      employer,
      company: `Cobalt ${String(employer).padStart(3, "0")} Systems`,
      family,
      title:
        family === "backend"
          ? titles[employer % titles.length]
          : family === "data"
            ? "Junior Data Analyst"
            : otherTitles[(employer + slot) % otherTitles.length],
      location:
        family === "backend"
          ? "Remote, United States"
          : family === "data"
            ? "Berlin, Germany"
            : ["Manchester, UK", "Berlin, Germany", "Paris, France"][
                employer % 3
              ],
      employment: family === "data" ? "PART_TIME" : "FULL_TIME",
      description:
        family === "backend"
          ? `Own the ${["billing", "observability", "developer platform", "data ingestion"][employer % 4]} services at Cobalt ${employer} Systems. Build and operate production APIs using ${employer % 2 ? "Go and PostgreSQL" : "Java and PostgreSQL"}, distributed queues and automated tests. This senior individual contributor position requires seven years of software engineering, experience improving production reliability, and thoughtful collaboration with product and infrastructure colleagues. You will design service boundaries, review code, mentor engineers, and measure latency and incident recovery. The team works remotely anywhere in the United States. No relocation is required. This is a full-time permanent role with health insurance, paid leave and a salary range of USD 150000 to 190000. Work authorization in the United States is required; sponsorship is not available. The role is hands-on and has no direct reports.`
          : family === "data"
            ? `Join the operations analytics team at Cobalt ${employer} Systems. This is an entry-level, part-time position for 20 hours each week in Berlin. Use SQL, Excel and Power BI to prepare recurring reports, validate source data, and explain sales and staffing trends. One year of professional or project experience is welcome; senior-level experience is not required. You will collaborate with a senior analyst, document metric definitions, check data quality, and present clear charts to nontechnical colleagues. Hybrid or onsite work in Berlin is available. Applicants must already be authorized to work in Germany. English is the working language; German is helpful but not required. Compensation is EUR 22 to 27 per hour, with paid leave and a predictable weekly schedule. This is a permanent part-time role, not an unpaid internship.`
            : `Cobalt ${employer} Systems seeks a ${otherTitles[(employer + slot) % otherTitles.length]} for a permanent role in ${["Manchester", "Berlin", "Paris"][employer % 3]}. This opening belongs to its own professional department and requires the corresponding occupational qualifications. Work with customers and colleagues on daily operations, maintain accurate records, follow professional standards and improve service quality. This is a full-time onsite position. It does not include software engineering, SQL analytics or business intelligence responsibilities. Apply with evidence of relevant professional training and experience.`,
    });
  }
const byId = new Map(jobs.map((job) => [job.id, job]));
const kind = (id) =>
  id < 540
    ? "employer"
    : id < 810
      ? "aggregator"
      : id < 840
        ? "empty"
        : id < 852
          ? "javascript"
          : id < 870
            ? "sign_in"
            : id < 882
              ? "blocked"
              : id < 892
                ? "rate_limited"
                : "slow";
const boardJobs = (id) => {
  if (id < 540) return jobs.slice(id * 8, id * 8 + 8);
  if (id < 810)
    return Array.from(
      { length: 40 },
      (_, i) => jobs[((id - 540) * 97 + i * 31) % jobs.length],
    );
  if (kind(id) === "empty") return [];
  return Array.from(
    { length: 10 },
    (_, i) => jobs[(id * 13 + i * 7) % jobs.length],
  );
};
const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><header>Local replica · Synthetic jobs only</header><main>${body}</main></body></html>`;

/** A deterministic, mixed 900-source catalog; no network or policy in production refers to it. */
export function createScaleRouter(options) {
  const aliases = [];
  let initializing;
  const metrics = {
    requests: 0,
    details: 0,
    lists: 0,
    browserData: 0,
    auth: 0,
    retries: 0,
    peakByHost: {},
  };
  const active = new Map(),
    limited = new Set();
  const origin = (req) => `http://${req.headers.host}`;
  const jobUrl = (job, port) =>
    `http://127.0.0.${(job.employer % 12) + 1}:${port}/scale-jobs/${job.id}`;
  const structured = (job, port) => ({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    url: jobUrl(job, port),
    identifier: { "@type": "PropertyValue", value: job.id },
    hiringOrganization: { "@type": "Organization", name: job.company },
    description: job.description,
    datePosted: new Date().toISOString().slice(0, 10),
    employmentType: job.employment,
    jobLocationType: job.family === "backend" ? "TELECOMMUTE" : undefined,
    applicantLocationRequirements: {
      "@type": "Country",
      name: job.family === "backend" ? "United States" : "Germany",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.family === "data" ? "Berlin" : "Remote",
        addressCountry: job.family === "data" ? "DE" : "US",
      },
    },
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: job.family === "data" ? "EUR" : "USD",
      value: {
        "@type": "QuantitativeValue",
        minValue: job.family === "data" ? 22 : 150000,
        maxValue: job.family === "data" ? 27 : 190000,
        unitText: job.family === "data" ? "HOUR" : "YEAR",
      },
    },
  });
  const cards = (items, id, port) =>
    id % 3 === 0
      ? `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: items.map((job) => structured(job, port)) })}</script>`
      : `<${id % 3 === 1 ? "ul" : "section"}>${items.map((job) => `<${id % 3 === 1 ? "li" : "article"} class="posting"><p class="company">${escape(job.company)}</p><h2><a href="${jobUrl(job, port)}">${escape(job.title)}</a></h2><p class="location">${escape(job.location)}</p><p>${job.employment === "PART_TIME" ? "Part-time" : "Full-time"}</p></${id % 3 === 1 ? "li" : "article"}>`).join("")}</${id % 3 === 1 ? "ul" : "section"}>`;
  const ensureAliases = () =>
    (initializing ??= Promise.all(
      Array.from({ length: 11 }, async (_, i) => {
        const server = http.createServer(options.dispatch);
        aliases.push(server);
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(options.port(), `127.0.0.${i + 2}`, resolve);
        });
      }),
    ));
  return {
    close() {
      for (const server of aliases) server.close();
    },
    async handle(req, res, url) {
      if (
        !/^\/(?:__scale__|scale-\d{3}|scale-jobs)(?:\/|$)/u.test(url.pathname)
      )
        return false;
      const send = (status, body, type = "text/html; charset=utf-8") => {
        res.writeHead(status, {
          "content-type": type,
          "cache-control": "no-store",
        });
        res.end(body);
        return true;
      };
      const port = options.port(),
        host = req.headers.host?.split(":")[0] ?? "unknown";
      metrics.requests++;
      const count = (active.get(host) ?? 0) + 1;
      active.set(host, count);
      metrics.peakByHost[host] = Math.max(metrics.peakByHost[host] ?? 0, count);
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        active.set(host, Math.max(0, (active.get(host) ?? 1) - 1));
      };
      res.once("finish", finish);
      res.once("close", finish);
      if (url.pathname === "/__scale__/manifest") {
        await ensureAliases();
        return send(
          200,
          JSON.stringify({
            sources: Array.from({ length: 900 }, (_, id) => ({
              id,
              label: `${kind(id)} ${String(id).padStart(3, "0")}`,
              url: `http://127.0.0.${(id % 12) + 1}:${port}/scale-${String(id).padStart(3, "0")}/`,
              kind: kind(id),
              listings: boardJobs(id).length,
            })),
            expected: {
              dev: jobs
                .filter((job) => job.family === "backend")
                .map((job) => ({
                  id: job.id,
                  url: jobUrl(job, port),
                  title: job.title,
                  company: job.company,
                })),
              lina: jobs
                .filter((job) => job.family === "data")
                .map((job) => ({
                  id: job.id,
                  url: jobUrl(job, port),
                  title: job.title,
                  company: job.company,
                })),
            },
            jobs: jobs.length,
          }),
          "application/json",
        );
      }
      if (url.pathname === "/__scale__/metrics")
        return send(200, JSON.stringify(metrics), "application/json");
      if (url.pathname === "/__scale__/reset" && req.method === "POST") {
        for (const key of Object.keys(metrics))
          metrics[key] = key === "peakByHost" ? {} : 0;
        limited.clear();
        return send(200, "{}", "application/json");
      }
      const detail = /^\/scale-jobs\/(company-\d+-role-\d+)$/u.exec(
        url.pathname,
      );
      if (detail) {
        const job = byId.get(detail[1]);
        if (!job) return send(404, "Not found");
        metrics.details++;
        await new Promise((resolve) => setTimeout(resolve, 8));
        return send(
          200,
          page(
            job.title,
            `<article><p>${escape(job.company)}</p><h1>${escape(job.title)}</h1><p>${escape(job.location)}</p><h2>About the role</h2><p>${escape(job.description)}</p><h2>How to apply</h2><p>This synthetic listing accepts no applications.</p></article><script type="application/ld+json">${JSON.stringify(structured(job, port))}</script>`,
          ),
        );
      }
      const match = /^\/scale-(\d{3})(?:\/(data|unlock))?\/?$/u.exec(
        url.pathname,
      );
      if (!match) return send(404, "Not found");
      const id = Number(match[1]),
        type = kind(id),
        unlock = `scale_access_${id}`;
      if (match[2] === "unlock" && req.method === "POST") {
        res.setHeader(
          "set-cookie",
          `${unlock}=1; Path=/; HttpOnly; SameSite=Lax`,
        );
        return send(200, "{}", "application/json");
      }
      const signed = (req.headers.cookie ?? "").includes(`${unlock}=1`);
      if ((type === "sign_in" || type === "blocked") && !signed) {
        metrics.auth++;
        return send(
          200,
          page(
            type === "blocked" ? "Verify you are human" : "Sign in",
            `<h1>${type === "blocked" ? "Verify you are human" : "Sign in to view these jobs"}</h1>${type === "sign_in" ? '<input type="password" aria-label="Synthetic password" disabled>' : ""}<p>Local fixture only. No real credentials.</p><button onclick="fetch('./unlock',{method:'POST'}).then(()=>location.reload())">Continue with synthetic session</button>`,
          ),
        );
      }
      if (type === "rate_limited" && !limited.has(id)) {
        limited.add(id);
        metrics.retries++;
        res.setHeader("retry-after", "0.2");
        return send(429, "Please retry shortly.");
      }
      if (type === "slow")
        await new Promise((resolve) => setTimeout(resolve, 800));
      else await new Promise((resolve) => setTimeout(resolve, 8));
      const items = boardJobs(id),
        start = Number(url.searchParams.get("page") ?? 0) * 20,
        visible = items.slice(start, start + 20);
      if (match[2] === "data") {
        metrics.browserData++;
        return send(200, cards(visible, id, port));
      }
      metrics.lists++;
      if (type === "javascript")
        return send(
          200,
          page(
            `Interactive board ${id}`,
            `<h1>Interactive board ${id}</h1><section id="jobs" aria-live="polite">Loading vacancies…</section><script>fetch('./data').then(r=>r.text()).then(html=>document.getElementById('jobs').innerHTML=html)</script>`,
          ),
        );
      const next =
        start + 20 < items.length
          ? `<a rel="next" href="?page=${start / 20 + 1}">Next page</a>`
          : "";
      return send(
        200,
        page(
          `Job board ${id}`,
          `<h1>${type === "employer" ? `Cobalt ${id} Systems careers` : `Job board ${id}`}</h1>${items.length ? cards(visible, id, port) : "<p>No open positions at the moment.</p>"}${next}`,
        ),
      );
    },
  };
}
