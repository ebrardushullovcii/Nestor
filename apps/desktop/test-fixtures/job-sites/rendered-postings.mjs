// Synthetic postings whose text exists only after the site's own script has
// fetched and rendered it, the way Workable and Workday serve a vacancy: the
// served HTML is a title and an empty app root. A board card points to one
// of them through "Apply on company website" and shows no description itself.

const postings = {
  workable: {
    title: "Full Stack .NET / Vue Developer (Mid/Senior)",
    company: "Fjordline Insurtech",
    location: "Remote, Europe",
    sections: [
      [
        "Description",
        [
          "Fjordline builds cloud underwriting and policy software for insurance carriers and brokers. The main product is an ASP.NET MVC 5 application on .NET Framework 4.8; new work is built on .NET 10 and Vue 3 on Azure.",
        ],
      ],
      [
        "What you will do",
        [
          "Deliver features end to end across API, UI, database and tests.",
          "Move legacy jQuery and Knockout screens to Vue 3 with TypeScript.",
          "Tune SQL Server and Azure SQL queries and EF Core mappings.",
        ],
      ],
      [
        "Requirements",
        [
          "Four or more years of professional C# and .NET experience.",
          "Production SQL Server experience, including query plans.",
          "Comfort working in English, in writing, across time zones.",
        ],
      ],
    ],
    pay: "$2,500-4,000 per month",
  },
  workday: {
    title: "Senior Platform Engineer",
    company: "Velvet Comet Gaming",
    location: "Remote, United Kingdom",
    sections: [
      [
        "About the role",
        [
          "Velvet Comet runs the platform behind its online casino titles. You will own build, deploy and observability for services written in Go and TypeScript.",
        ],
      ],
      [
        "Responsibilities",
        [
          "Run Kubernetes clusters on AWS with Terraform.",
          "Keep CI/CD pipelines fast and the on-call rota calm.",
          "Write runbooks and lead incident reviews.",
        ],
      ],
      [
        "Qualifications",
        [
          "Five or more years of platform or DevOps engineering.",
          "Hands-on Terraform, Kubernetes and Prometheus.",
        ],
      ],
    ],
    pay: null,
  },
};

const delayMs = 1_500;

function shell(title, apiPath) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><div id="app"></div><script>
fetch(${JSON.stringify(apiPath)}).then((response) => response.json()).then((job) => {
  const app = document.getElementById('app');
  app.innerHTML = '<main><p>' + job.company + '</p><h1>' + job.title + '</h1><p>' + job.location + '</p>' +
    (job.pay ? '<p>Pay: ' + job.pay + '</p>' : '') +
    job.sections.map(([heading, lines]) => '<h2>' + heading + '</h2>' + (lines.length > 1 ? '<ul>' + lines.map((line) => '<li>' + line + '</li>').join('') + '</ul>' : '<p>' + lines[0] + '</p>')).join('') +
    '<a href="' + job.applyUrl + '">Apply for this job</a></main>';
});
</script></body></html>`;
}

export async function handleRenderedPostings(_req, _res, url, { send }) {
  const path = url.pathname;
  const api = /^\/rendered-postings\/api\/(workable|workday)\/1$/u.exec(path);
  if (api) {
    // The posting arrives well after the page itself has loaded.
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const job = postings[api[1]];
    send(
      200,
      JSON.stringify({
        ...job,
        applyUrl: `/rendered-postings/${api[1]}/apply/1`,
      }),
      "application/json",
    );
    return true;
  }
  if (path === "/rendered-postings/workable/j/1/") {
    const job = postings.workable;
    send(
      200,
      shell(
        `${job.title} - ${job.company}`,
        "/rendered-postings/api/workable/1",
      ),
    );
    return true;
  }
  if (path === "/rendered-postings/workday/job/1") {
    const job = postings.workday;
    send(200, shell(job.title, "/rendered-postings/api/workday/1"));
    return true;
  }
  if (path === "/rendered-postings/board/jobs/view/1") {
    // A board's card for the Workday posting: title, employer, place and the
    // employer's own posting, no description.
    const job = postings.workday;
    send(
      200,
      `<!doctype html><title>${job.title} | ${job.company}</title><main><h1>${job.title}</h1><p>${job.company} · ${job.location}</p><a href="/rendered-postings/workday/job/1" target="_blank" rel="noopener">Apply on company website</a></main>`,
    );
    return true;
  }
  if (/^\/rendered-postings\/(workable|workday)\/apply\/1$/u.test(path)) {
    send(
      200,
      "<!doctype html><title>Apply</title><h1>Application form</h1><p>This replica form accepts no submissions.</p>",
    );
    return true;
  }
  return false;
}
