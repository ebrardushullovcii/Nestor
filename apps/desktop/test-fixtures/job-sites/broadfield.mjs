// A big board: 600 jobs on six result pages of 100, half of them engineering
// and half kitchen roles, so screening and detail reads both have real work.
// Each posting page links to sibling postings, as many boards do: three more
// at the same company and two archived roles that are not on the board.
const PER_PAGE = 100;
const TOTAL = 600;
const companies = [
  "Fernhollow",
  "Brackwater Labs",
  "Oakhaven Systems",
  "Ridgeline Data",
  "Marlowe Works",
];
const engineering = ["Software Engineer", "Backend Engineer", "Web Developer"];
const kitchen = ["Pastry Chef", "Line Cook", "Kitchen Porter"];
const jobs = Array.from({ length: TOTAL }, (_, index) => {
  const id = index + 1;
  const roles = id % 2 ? engineering : kitchen;
  return {
    id: String(id),
    title: `${roles[index % roles.length]} (Req ${String(id).padStart(4, "0")})`,
    company: companies[index % companies.length],
    location: "Remote, Europe",
  };
});

const escape = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const shell = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)} — Broadfield Jobs</title></head><body><header><a href="/broadfield/jobs">Broadfield Jobs</a></header><main>${body}</main></body></html>`;

export function handleBroadfield(_req, _res, url, { send }) {
  const path = url.pathname;
  if (!path.startsWith("/broadfield/")) return false;
  if (path === "/broadfield/jobs") {
    const pages = Math.ceil(jobs.length / PER_PAGE);
    const current = Math.min(
      pages,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
      ),
    );
    const shown = jobs.slice((current - 1) * PER_PAGE, current * PER_PAGE);
    send(
      200,
      shell(
        `Jobs, page ${current}`,
        `<h1>${jobs.length} jobs</h1><ul>${shown.map((job) => `<li><article><h2><a href="/broadfield/job/${job.id}">${escape(job.title)}</a></h2><p>${escape(job.company)} · ${escape(job.location)}</p></article></li>`).join("")}</ul><nav aria-label="Pagination"><p>Page ${current} of ${pages}</p>${current > 1 ? `<a href="/broadfield/jobs?page=${current - 1}">Previous</a> ` : ""}${current < pages ? `<a rel="next" href="/broadfield/jobs?page=${current + 1}">Next</a>` : ""}</nav>`,
      ),
    );
    return true;
  }
  const detail = /^\/broadfield\/job\/([1-9]\d*)$/u.exec(path);
  const job = detail && jobs.find((entry) => entry.id === detail[1]);
  if (!job) {
    send(404, shell("Not found", "<h1>Page not found</h1>"));
    return true;
  }
  const id = Number(job.id);
  const siblings = [1, 2, 3]
    .map((step) => jobs[(id - 1 + step * companies.length) % jobs.length])
    .filter((sibling) => sibling.id !== job.id);
  send(
    200,
    shell(
      `${job.title} at ${job.company}`,
      `<article><h1>${escape(job.title)}</h1><p>${escape(job.company)} · ${escape(job.location)}</p><p>Work on ${escape(job.company)}'s products with a small team. Fictional posting for local tests.</p><p><a href="/broadfield/apply/${job.id}">Apply for this job</a></p></article><aside><h2>More jobs at ${escape(job.company)}</h2><ul>${siblings.map((sibling) => `<li><a href="/broadfield/job/${sibling.id}">${escape(sibling.title)}</a></li>`).join("")}</ul><h2>Similar roles, now closed</h2><ul><li><a href="/broadfield/archived/${id}-a">Archived role A</a></li><li><a href="/broadfield/archived/${id}-b">Archived role B</a></li></ul></aside>`,
    ),
  );
  return true;
}
