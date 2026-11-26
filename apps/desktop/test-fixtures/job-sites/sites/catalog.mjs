// Fictional brands only. These options belong to fixtures, never product policy.
export const moreSites = [
  {
    slug: "atlas",
    name: "Atlas Acorn Jobs",
    count: 300,
    pagination: "page",
    style: "plain",
    description:
      "Page numbers, query filters, sorting, duplicate jobs, sponsored cards and discovery decoys.",
  },
  {
    slug: "ripple",
    name: "Ripple Thimble Jobs",
    count: 300,
    pagination: "offset",
    style: "drop",
    description:
      "Load more, query filters, duplicate jobs, initials-only companies and a local ATS redirect.",
  },
  {
    slug: "brindle",
    name: "Brindle Button Collective",
    count: 120,
    company: true,
    steps: 4,
    style: "parse",
    groups: ["history", "education", "questions"],
    description:
      "Department filters, four steps, resume prefill and repeatable work and education.",
  },
  {
    slug: "folio",
    name: "Folio Fern Studio",
    count: 36,
    style: "drop",
    groups: ["links", "motivation"],
    cover: true,
    description:
      "Portfolio URLs, a required cover-letter upload and a limited rich text answer.",
  },
  {
    slug: "harbor-health",
    name: "Harbor Hush Care",
    count: 48,
    steps: 5,
    style: "plain",
    groups: ["country", "dates", "skills", "questions", "diversity"],
    description:
      "Five steps, phone codes, availability dates, skill experience and voluntary diversity.",
  },
  {
    slug: "lessonloom",
    name: "Lessonloom Lantern",
    count: 42,
    steps: 3,
    style: "paste",
    groups: ["education", "motivation"],
    description:
      "Three steps, upload or paste a resume, education rows and teaching motivation.",
  },
  {
    slug: "parcelpath",
    name: "Parcelpath Pebble",
    count: 60,
    steps: 4,
    style: "drop",
    groups: ["country", "dates", "salary", "questions"],
    description:
      "Four steps, searchable country picker, phone codes, dates and salary currency.",
  },
  {
    slug: "clientnest",
    name: "Clientnest Cobalt",
    count: 45,
    style: "plain",
    groups: ["country", "questions", "skills"],
    description:
      "Single page, searchable comboboxes, yes/no questions and multiple skill checkboxes.",
  },
  {
    slug: "ledgerleaf",
    name: "Ledgerleaf Lantern",
    count: 40,
    steps: 6,
    style: "plain",
    groups: ["history", "salary", "skills", "questions", "diversity"],
    description:
      "Six steps, work history, salary expectations, notice period and review.",
  },
  {
    slug: "marketmoss",
    name: "Marketmoss Marble",
    count: 50,
    style: "paste",
    groups: ["links", "motivation", "skills"],
    description:
      "Resume text alternative, validated URLs and a rich answer with a character counter.",
  },
  {
    slug: "peoplepetal",
    name: "Peoplepetal Paper",
    count: 36,
    steps: 3,
    style: "drop",
    groups: ["questions", "diversity"],
    description:
      "Three steps, voluntary EEO answers, declarations and an unticked marketing option.",
  },
  {
    slug: "cedar-ats",
    name: "Cedar Cuff Applicant Desk",
    count: 55,
    steps: 4,
    style: "parse",
    groups: ["history", "questions"],
    guest: true,
    timeout: true,
    description:
      "Local ATS handoff, guest/account choice, resume prefill and session timeout recovery.",
  },
  {
    slug: "framehire",
    name: "Framehire Finch",
    count: 30,
    style: "plain",
    groups: ["questions"],
    iframe: true,
    description:
      "Same-origin application iframe with inline validation and receipt.",
  },
  {
    slug: "slowgrove",
    name: "Slowgrove Spool",
    count: 28,
    steps: 3,
    style: "drop",
    groups: ["dates", "questions"],
    slow: true,
    description:
      "Three-to-eight-second page responses and a three-step application.",
  },
  {
    slug: "pacer",
    name: "Pacer Pollen Jobs",
    count: 44,
    style: "plain",
    groups: ["salary", "questions"],
    rateLimit: true,
    removedGone: true,
    description:
      "Short HTTP 429 cooldown (Retry-After on listing pages, none on job pages), a removed job that answers HTTP 410, and a single-page application.",
  },
].map((site, index) => ({
  pagination: "page",
  groups: [],
  ...site,
  theme: index,
}));
