// A long board: six result pages for everyone, two more after signing in.
// The landing page is a search form with no cards, like boards whose results
// appear only after a search, so reading the list is the browser agent's job.
const roles = [
  "Senior Full-Stack Engineer",
  "Software Engineer",
  "Backend Engineer",
  "Frontend Engineer",
  "Platform Engineer",
  "Staff Software Engineer",
  "TypeScript Developer",
  "Site Reliability Engineer",
];
const companies = [
  "Quillmoor",
  "Ashgrove Labs",
  "Tidewell",
  "Brightfen",
  "Corvel Systems",
  "Lumenhart",
  "Pinecrest Data",
  "Orrin Works",
  "Saltmarsh",
  "Kestrel Grid",
];
const places = ["Remote, Europe", "Berlin, Germany", "Lisbon, Portugal"];
const PUBLIC = 60;
const MEMBERS = 20;
const PER_PAGE = 10;
const jobs = Array.from({ length: PUBLIC + MEMBERS }, (_, index) => ({
  id: String(index + 1),
  title: roles[index % roles.length],
  company: companies[index % companies.length],
  location: places[index % places.length],
  members: index >= PUBLIC,
}));

const escape = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)} — Longboard Jobs</title></head><body><header><a href="/longboard/">Longboard Jobs</a></header><main>${body}</main></body></html>`;
const signInForm = (error = "") =>
  `<h1>Sign in to Longboard Jobs</h1><p>Members see every job on the board. Use a made-up email and password for this local test.</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}<form method="post" action="/longboard/signin"><label>Email<input name="email" type="email" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`;

export async function handleLongboard(req, res, url, { send, readPost }) {
  const path = url.pathname;
  if (!path.startsWith("/longboard/")) return false;
  const member = /(?:^|;\s*)fixture_longboard=1(?:;|$)/u.test(
    req.headers.cookie ?? "",
  );
  if (path === "/longboard/signin") {
    if (req.method === "POST") {
      const fields = await readPost(req);
      if (!fields.email?.trim() || !fields.password?.trim()) {
        send(
          400,
          shell("Sign in", signInForm("Email and password are required.")),
        );
        return true;
      }
      res.writeHead(303, {
        Location: "/longboard/jobs",
        "Set-Cookie":
          "fixture_longboard=1; HttpOnly; SameSite=Lax; Path=/longboard",
      });
      res.end();
      return true;
    }
    send(200, shell("Sign in", signInForm()));
    return true;
  }
  if (path === "/longboard/") {
    send(
      200,
      shell(
        "Find your next role",
        `<h1>Find your next software role</h1><form method="get" action="/longboard/jobs"><label>Keywords<input name="q" placeholder="Title or skill"></label><button>Search jobs</button></form><p>${member ? "You are signed in." : `<a href="/longboard/signin">Sign in</a> to see members-only jobs.`}</p>`,
      ),
    );
    return true;
  }
  if (path === "/longboard/jobs") {
    const visible = jobs.filter((job) => member || !job.members);
    const pages = Math.ceil(visible.length / PER_PAGE);
    const current = Math.min(
      pages,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
      ),
    );
    const query = url.searchParams.get("q") ?? "";
    const href = (page) =>
      `/longboard/jobs?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(page) })}`;
    const shown = visible.slice((current - 1) * PER_PAGE, current * PER_PAGE);
    send(
      200,
      shell(
        `Jobs, page ${current}`,
        `<h1>${visible.length} jobs</h1>${member ? "<p>Signed in: members see every job.</p>" : `<p>${MEMBERS} more jobs are open to members only. <a href="/longboard/signin">Sign in</a> to see them.</p>`}<ul>${shown.map((job) => `<li><article><h2><a href="/longboard/job/${job.id}">${escape(job.title)}</a></h2><p>${escape(job.company)} · ${escape(job.location)}</p></article></li>`).join("")}</ul><nav aria-label="Pagination"><p>Page ${current} of ${pages}</p>${current > 1 ? `<a href="${href(current - 1)}">Previous</a> ` : ""}${current < pages ? `<a rel="next" href="${href(current + 1)}">Next</a>` : ""}</nav>`,
      ),
    );
    return true;
  }
  const detail = /^\/longboard\/job\/([1-9]\d*)$/u.exec(path);
  const job = detail && jobs.find((entry) => entry.id === detail[1]);
  if (!job) {
    send(404, shell("Not found", "<h1>Page not found</h1>"));
    return true;
  }
  if (job.members && !member) {
    send(401, shell("Sign in", signInForm()));
    return true;
  }
  send(
    200,
    shell(
      `${job.title} at ${job.company}`,
      `<h1>${escape(job.title)}</h1><p>${escape(job.company)} · ${escape(job.location)}</p><p>Build and run TypeScript services and React interfaces for ${escape(job.company)}. Fictional posting for local tests.</p>`,
    ),
  );
  return true;
}
