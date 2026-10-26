import { CandidateProfileSchema, type JobSearchGoals, type RoleScreenGoals } from "@nestor/contracts";

const shared = {
  id: "synthetic_search_eval", fullName: "Synthetic Search Candidate",
  headline: "Senior software engineer", summary: "Synthetic evaluation persona, not a real applicant.",
  email: "search-eval@example.com", currentLocation: "Chicago, Illinois, United States",
  currentCity: "Chicago", currentCountry: "United States", yearsExperience: 9,
  baseResume: { id: "synthetic_resume", fileName: "synthetic.txt", uploadedAt: "2026-10-26T00:00:00.000Z", textContent: "Synthetic evaluation only." },
  workEligibility: { authorizedWorkCountries: ["United States"], requiresVisaSponsorship: false, willingToRelocate: false, remoteEligible: true },
};

export const searchPersonas = [
  {
    id: "volume",
    description: "High volume: senior full-stack IC in Chicago; US/global remote. Broad backend, frontend and product engineering; transferable stacks welcome. No management or sales roles.",
    screen: { targetRoles: ["Senior Full Stack Engineer", "Software Engineer"], relatedRoles: ["Backend Engineer", "Frontend Engineer", "Product Engineer", "Platform Engineer"], strategy: "wide_net" } satisfies RoleScreenGoals,
    goals: { targetRoles: ["Senior Full Stack Engineer", "Software Engineer"], jobFamilies: ["Backend Engineer", "Frontend Engineer", "Product Engineer", "Platform Engineer"], locations: ["United States", "Remote"], workModes: ["remote"], seniorityLevels: ["senior", "staff"], employmentTypes: ["Full-time"] } satisfies JobSearchGoals,
    request: "Senior hands-on product/software engineering. Remote from Chicago, US work authorization only. Broad transferable stacks; willing to learn Go, Java or PHP. Do not prioritize management, sales, customer support, ML research or pure operations.",
    profile: CandidateProfileSchema.parse({
      ...shared,
      summary: "Nine years shipping full-stack SaaS products. Senior hands-on IC with backend depth, React interfaces, APIs, databases and cloud delivery. Comfortable learning another language.",
      skills: ["TypeScript", "JavaScript", "React", "Node.js", "Python", "PostgreSQL", "Redis", "AWS", "Docker", "Kubernetes", "REST APIs", "Distributed systems", "Testing", "Accessibility"],
      experiences: [{ id: "synthetic_volume", companyName: "Example Product Company", title: "Senior Full Stack Engineer", startDate: "2017-01", endDate: null, isCurrent: true, summary: "Built and operated multi-tenant SaaS products; React/TypeScript frontends, Node/Python services, PostgreSQL APIs and event pipelines. Led technical delivery and mentored engineers without people management. Owned reliability, automated tests and production releases.", achievements: ["Shipped accessible product interfaces and backend integrations", "Designed APIs and improved service reliability"] }],
    }),
  },
  {
    id: "close",
    description: "Few close matches: senior frontend/product IC in Chicago; remote from the US, React/TypeScript customer-facing web products. Avoid backend-only, management, sales and non-US hiring.",
    screen: { targetRoles: ["Senior Frontend Engineer"], relatedRoles: ["Product Engineer", "Full Stack Engineer"], strategy: "related_roles" } satisfies RoleScreenGoals,
    goals: { targetRoles: ["Senior Frontend Engineer"], jobFamilies: ["Product Engineer", "Full Stack Engineer"], locations: ["United States", "Remote"], workModes: ["remote"], seniorityLevels: ["senior"], employmentTypes: ["Full-time"] } satisfies JobSearchGoals,
    request: "Only close matches: senior IC building customer-facing React/TypeScript web products, including frontend-heavy full-stack/product engineering. Must allow remote work from Chicago. No backend-only, infrastructure, native mobile, management or customer-facing sales/support roles.",
    profile: CandidateProfileSchema.parse({
      ...shared, headline: "Senior frontend product engineer",
      summary: "Nine years building accessible customer-facing web products; seven years of React and TypeScript. Prefers hands-on frontend product work and a small number of close matches.",
      skills: ["React", "TypeScript", "JavaScript", "HTML", "CSS", "Accessibility", "Design systems", "Playwright", "Jest", "GraphQL", "Node.js", "PostgreSQL", "Web performance"],
      experiences: [{ id: "synthetic_close", companyName: "Example Web Products", title: "Senior Frontend Engineer", startDate: "2017-01", endDate: null, isCurrent: true, summary: "Built customer-facing React/TypeScript SaaS products and accessible design systems. Collaborated with design, owned web performance and automated testing. Implemented supporting Node APIs; frontend product work remained the focus.", achievements: ["Delivered accessible data-rich interfaces", "Maintained a shared React component library"] }],
    }),
  },
];
