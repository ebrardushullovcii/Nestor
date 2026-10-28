export const knownSkillPhrases = [
  "React",
  "React Native",
  "TypeScript",
  "JavaScript",
  "C#",
  "Node.js",
  "Node",
  "Next.js",
  "Express.js",
  "ASP.NET",
  ".NET Core",
  ".NET Framework",
  "Entity Framework",
  "MVC",
  "Electron",
  "Playwright",
  "Vitest",
  "Storybook",
  "axe",
  "SQLite",
  "Figma",
  "Design Systems",
  "Product Design",
  "UX Strategy",
  "Accessibility",
  "Performance Optimization",
  "Python",
  "Tableau",
  "AWS",
  "Azure",
  "SQL Server",
  "MySQL",
  "PostgreSQL",
  "MongoDB",
  "Docker",
  "WebSockets",
  "Postman",
  "Jira",
  "Selenium",
  "Cypress",
  "GraphQL",
  "SQL",
  "CSS",
  "HTML",
  "OAuth",
  "JWT",
  "TailwindCSS",
  "ShadCN",
  "REST APIs",
] as const;

export const knownSoftSkillPhrases = [
  "Leadership",
  "Communication",
  "Problem-solving",
  "Adaptability",
  "Mentoring",
  "Collaboration",
  "Stakeholder alignment",
  "Facilitation",
] as const;

export const skillSectionAliases = [
  "SKILLS",
  "TECHNICAL SKILLS",
  "CORE SKILLS",
  "KEY SKILLS",
] as const;

export const summarySectionAliases = [
  "ABOUT ME",
  "ABOUT MYSELF",
  "ABOUT",
  "SUMMARY",
  "PROFILE",
  "PERSONAL PROFILE",
  "PROFESSIONAL SUMMARY",
  "PROFESSIONAL PROFILE",
] as const;

export const experienceSectionAliases = [
  "WORK EXPERIENCE",
  "PROFESSIONAL EXPERIENCE",
  "RELEVANT WORK EXPERIENCE",
  "RELEVANT EXPERIENCE",
  "EXPERIENCE",
  "WORK HISTORY",
  "EMPLOYMENT HISTORY",
  "EMPLOYMENT",
  "CAREER HISTORY",
  "CAREER EXPERIENCE",
  "PROFESSIONAL BACKGROUND",
  "BACKGROUND",
  "INTERNSHIP",
  "INTERNSHIPS",
  "INTERNSHIP EXPERIENCE",
  "INTERN EXPERIENCE",
] as const;

export const projectSectionAliases = [
  "PROJECTS",
  "PROJECT EXPERIENCE",
] as const;

export const educationSectionAliases = [
  "EDUCATION AND TRAINING",
  "EDUCATION",
] as const;

export const languageSectionAliases = ["LANGUAGE SKILLS", "LANGUAGES"] as const;

export const certificationSectionAliases = [
  "CERTIFICATIONS",
  "CERTIFICATES",
] as const;

export const resumeSectionHeadings = new Set<string>([
  ...summarySectionAliases,
  ...skillSectionAliases,
  ...experienceSectionAliases,
  ...projectSectionAliases,
  ...educationSectionAliases,
  ...languageSectionAliases,
  ...certificationSectionAliases,
  "WORK ELIGIBILITY",
  "WORK AUTHORIZATION",
  "RIGHT TO WORK",
  "VISA SPONSORSHIP",
  "ELIGIBILITY",
  "TARGET ROLES",
  "OBJECTIVE",
  "CAREER OBJECTIVE",
  "WORK PREFERENCES",
  "EMPLOYMENT PREFERENCES",
  "ACTIVITIES",
  "EXTRACURRICULAR",
  "EXTRACURRICULAR ACTIVITIES",
  "VOLUNTEER",
  "VOLUNTEER EXPERIENCE",
  "VOLUNTEERING",
  "DISCLAIMER",
  "REFERENCES",
]);

export const contactOrMetaPattern =
  /date of birth|nationality|phone|email|website|address|skills|experience|education|frameworks|languages|databases|tools|soft skills/i;

export const headlineKeywordPattern =
  /\b(software|full-stack|frontend|backend|web|react|node|\.net|chief)?\s*(engineer|developer|designer|manager|lead|architect|specialist|consultant|analyst|officer)\b/i;

export const experienceSectionHeadingPattern =
  /^(?:(?:(?:relevant|professional|full[- ]?time|work|employment|career|industry|selected|additional)(?:\s+(?:work|professional))?\s+(?:experience|history|background))|(?:internships?|intern)\s+experience|(?:relevant\s+)?experience|employment|background|work\s+history|employment\s+history|career\s+history|professional\s+background|internships?)\s*[:\-–—]?\s*$/i;

export const nonExperienceSectionHeadingPattern =
  /^(?:about(?:\s+myself|\s+me)?|summary|profile|professional\s+profile|(?:technical|core|key|additional)?\s*skills?|projects?|project\s+experience|education(?:\s*(?:,|&|and)?\s*(?:training|certifications?|certificates?))?|academic\s+background|training(?:\s+(?:and|&)\s+education)?|language(?:\s+skills?)?|languages?|certifications?|certificates?|publications?|awards?|honors?|(?:extracurricular\s+)?activities|extracurricular|volunteer(?:ing|\s+experience)?|(?:work|employment)\s+preferences|(?:career\s+)?objective|disclaimer|references)\s*[:\-–—]?\s*$|^preferred\s+locations?\s*:\s*.+$/i;

export const skillCategoryHeadingPattern =
  /^(frameworks|programming languages|languages|databases|tools|security(?:\s*&\s*authentication)?|soft skills)$/i;

export const dateRangePattern =
  /((?:\d{4}-\d{2}(?:-\d{2})?)|(?:\d{1,2}\/\d{1,2}\/\d{4})|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+)?(?:\d{1,2}\/)?\d{4})\s*[–—-]\s*(current|present|(?:\d{4}-\d{2}(?:-\d{2})?)|(?:\d{1,2}\/\d{1,2}\/\d{4})|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+)?(?:\d{1,2}\/)?\d{4})/i;

export const knownPersonalWebsitePlatformDomains = [
  "coursera.org",
  "dev.to",
  "edx.org",
  "facebook.com",
  "github.com",
  "github.io",
  "hashnode.dev",
  "linkedin.com",
  "linkedinlearning.com",
  "medium.com",
  "npmjs.com",
  "stackoverflow.com",
  "substack.com",
  "twitter.com",
  "udemy.com",
  "x.com",
] as const;

export const likelyPersonalWebsitePaths = new Set([
  "",
  "/",
  "/about",
  "/contact",
  "/cv",
  "/home",
  "/portfolio",
  "/resume",
]);
