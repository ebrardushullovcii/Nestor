// Small, synthetic fit inventory: identical work with different stated hours.
const cases = [
  {
    id: "part-time",
    hours: "20 hours per week",
    employment: "PART_TIME",
    age: 2,
  },
  {
    id: "full-time",
    hours: "40 hours per week",
    employment: "FULL_TIME",
    age: 2,
  },
  {
    id: "unknown-hours",
    hours: "Weekly hours will be agreed with the successful applicant",
    employment: null,
    age: 2,
  },
  { id: "older", hours: "20 hours per week", employment: "PART_TIME", age: 70 },
  {
    id: "closed",
    hours: "20 hours per week",
    employment: "PART_TIME",
    age: 70,
    closed: true,
  },
];
const body = (job) =>
  `Join the fictional Permit Fit Lab analytics team in Berlin, Germany. This entry-level Junior Data Analyst position involves SQL, Python and Power BI dashboards, data quality checks, and explaining results to colleagues. One year of professional or project experience is welcome. This is a fixed-term student-friendly contract from 1 November 2026 to 30 June 2027. English is the working language. The role requires ${job.hours}. Work is hybrid in Berlin. You must have current permission to work in Germany for the advertised hours. Current conditional permits are accepted when their stated conditions cover this job. Employer sponsorship for full-time work is not available. Salary is EUR 22 to 27 per hour. This is a local replica with synthetic data.`;

export function handlePermitFit(req, res, url, { send }) {
  if (!url.pathname.startsWith("/permit-fit/")) return false;
  if (req.method !== "GET") {
    send(405, "Read-only replica");
    return true;
  }
  const job = cases.find(
    (item) => url.pathname === `/permit-fit/jobs/${item.id}`,
  );
  if (job) {
    const posting = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: `Junior Data Analyst, ${job.id}`,
      description: body(job),
      hiringOrganization: {
        "@type": "Organization",
        name: `Permit Fit Lab ${job.id}`,
      },
      jobLocation: {
        "@type": "Place",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Berlin",
          addressCountry: "DE",
        },
      },
      datePosted: new Date(Date.now() - job.age * 86_400_000)
        .toISOString()
        .slice(0, 10),
      ...(job.closed
        ? { validThrough: new Date(Date.now() - 86_400_000).toISOString() }
        : {}),
      ...(job.employment ? { employmentType: job.employment } : {}),
    };
    send(
      200,
      `<!doctype html><html lang="en"><head><title>${posting.title}</title><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body><main><h1>${posting.title}</h1><p>${posting.hiringOrganization.name}</p><p>Berlin, Germany</p><p>${body(job)}</p><p>Posted ${job.age} days ago</p></main></body></html>`,
    );
  } else {
    send(
      200,
      `<!doctype html><html lang="en"><title>Permit Fit Lab jobs</title><h1>Open jobs</h1><main>${cases.map((item) => `<article><h2><a href="/permit-fit/jobs/${item.id}">Junior Data Analyst, ${item.id}</a></h2><p>Permit Fit Lab ${item.id}</p><p>Berlin, Germany</p><p>${item.hours}</p><p>Posted ${item.age} days ago</p></article>`).join("")}</main></html>`,
    );
  }
  return true;
}

