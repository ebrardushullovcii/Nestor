import { describe, expect, test } from "vitest";
import type {
  JobFinderSettings,
  ResumeTemplateId,
} from "@nestor/contracts";
import type { ResumeRenderDocument } from "@nestor/job-finder";

import {
  listLocalResumeTemplates,
  renderResumeTemplateCatalogPreviewHtml,
  renderResumeTemplateHtml,
} from "./job-finder-resume-renderer";

const baseRenderDocument: ResumeRenderDocument = {
  fullName: "Alex <Vanguard>",
  headline: "Senior systems designer",
  location: "London, UK",
  contactItems: [
    { field: "email", text: "alex@example.com" },
    { field: "portfolioUrl", text: "https://alex.example.com" },
  ],
  sections: [
    {
      id: "section_summary",
      kind: "summary",
      label: "Summary",
      text: "Builds resilient workflow systems.",
      bullets: [],
      entries: [],
    },
    {
      id: "section_experience",
      kind: "experience",
      label: "Experience",
      text: null,
      bullets: [],
      entries: [
        {
          id: "entry_1",
          title: "Senior systems designer",
          subtitle: "Signal Systems",
          location: "London, UK",
          dateRange: "Jan 2020 – Present",
          startDate: "2020-01",
          endDate: null,
          isCurrent: true,
          heading:
            "Senior systems designer — Signal Systems | London, UK | Jan 2020 – Present",
          summary: "Owns workflow platform delivery.",
          bullets: [
            {
              id: "entry_1_bullet_1",
              text: "Improved designer-engineer handoff <quality> by 30%.",
            },
          ],
        },
      ],
    },
    {
      id: "section_skills",
      kind: "skills",
      label: "Core Skills",
      text: null,
      bullets: [
        { id: "skill_1", text: "Figma" },
        { id: "skill_2", text: "Design Systems" },
      ],
      entries: [],
    },
    {
      id: "section_projects",
      kind: "projects",
      label: "Projects",
      text: null,
      bullets: [],
      entries: [
        {
          id: "project_1",
          title: "Workflow OS",
          subtitle: "Design lead",
          location: null,
          dateRange: null,
          startDate: null,
          endDate: null,
          isCurrent: false,
          heading: "Workflow OS — Design lead",
          summary: "Scaled an internal design system.",
          bullets: [
            {
              id: "project_1_bullet_1",
              text: "Created accessible interaction patterns.",
            },
          ],
        },
      ],
    },
    {
      id: "section_additional_skills",
      kind: "skills",
      label: "Additional Skills",
      text: null,
      bullets: [
        { id: "add_skill_1", text: "React" },
        { id: "add_skill_2", text: "Playwright" },
      ],
      entries: [],
    },
    {
      id: "section_languages",
      kind: "skills",
      label: "Languages",
      text: null,
      bullets: [{ id: "lang_1", text: "English — Native" }],
      entries: [],
    },
    {
      id: "section_keywords",
      kind: "keywords",
      label: "Targeted Keywords",
      text: null,
      bullets: [{ id: "keyword_1", text: "Should not render" }],
      entries: [],
    },
  ],
};

const credentialHeavyRenderDocument: ResumeRenderDocument = {
  ...baseRenderDocument,
  sections: [
    baseRenderDocument.sections[0]!,
    {
      id: "section_certifications",
      kind: "certifications",
      label: "Certifications",
      text: null,
      bullets: [],
      entries: [
        {
          id: "cert_1",
          title: "AWS Certified Solutions Architect",
          subtitle: "Amazon Web Services",
          location: null,
          dateRange: "2024",
          startDate: "2024",
          endDate: null,
          isCurrent: false,
          heading:
            "AWS Certified Solutions Architect | Amazon Web Services | 2024",
          summary:
            "Validated distributed systems depth for platform-heavy roles.",
          bullets: [
            {
              id: "cert_1_bullet_1",
              text: "Maintains current cloud architecture certification.",
            },
          ],
        },
      ],
    },
    {
      id: "section_education",
      kind: "education",
      label: "Education",
      text: null,
      bullets: [],
      entries: [
        {
          id: "edu_1",
          title: "MSc Human Computer Interaction",
          subtitle: "City University",
          location: null,
          dateRange: "2015",
          startDate: "2015",
          endDate: null,
          isCurrent: false,
          heading: "MSc Human Computer Interaction | City University | 2015",
          summary: null,
          bullets: [
            {
              id: "edu_1_bullet_1",
              text: "Research focus on applied systems design.",
            },
          ],
        },
      ],
    },
    ...baseRenderDocument.sections.slice(1),
  ],
};

function renderTemplate(
  templateId: ResumeTemplateId,
  renderDocument: ResumeRenderDocument = baseRenderDocument,
  fontPreset: JobFinderSettings["fontPreset"] = "inter_requisite",
  options?: Parameters<typeof renderResumeTemplateHtml>[1],
): string {
  return renderResumeTemplateHtml(
    {
      renderDocument,
      templateId,
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: templateId,
        fontPreset,
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        keepSessionAlive: false,
        discoveryOnly: false,
      },
    },
    options,
  );
}

describe("job finder resume renderer", () => {
  test("lists eight ATS-safe local templates with family metadata", () => {
    expect(listLocalResumeTemplates()).toEqual([
      expect.objectContaining({
        id: "classic_ats",
        label: "Chronology Classic",
        familyLabel: "Chronology Classic",
        density: "balanced",
        visualTags: ["Standard ATS", "Reverse chronology", "Traditional"],
      }),
      expect.objectContaining({
        id: "compact_exec",
        label: "Senior Brief",
        familyLabel: "Senior Brief",
        density: "compact",
        visualTags: [
          "Experienced professional",
          "Dense timeline",
          "High signal",
        ],
      }),
      expect.objectContaining({
        id: "modern_split",
        label: "Modern Editorial",
        familyLabel: "Modern Editorial",
        density: "balanced",
        visualTags: ["Modern professional", "Single column", "Balanced"],
      }),
      expect.objectContaining({
        id: "technical_matrix",
        label: "Engineering Spec",
        familyLabel: "Engineering Spec",
        density: "compact",
      }),
      expect.objectContaining({
        id: "project_showcase",
        label: "Proof Portfolio",
        familyLabel: "Proof Portfolio",
        density: "comfortable",
      }),
      expect.objectContaining({
        id: "credentials_focus",
        label: "Formal Proof",
        familyLabel: "Formal Proof",
        density: "balanced",
      }),
      expect.objectContaining({
        id: "timeline_longform",
        label: "Longform Timeline",
        familyLabel: "Longform Timeline",
        density: "compact",
      }),
      expect.objectContaining({
        id: "career_pivot",
        label: "Career Pivot Bridge",
        familyLabel: "Career Pivot Bridge",
        density: "balanced",
      }),
    ]);
  });

  test("renders ATS-safe classic html without keyword section bleed and with escaping", () => {
    const html = renderTemplate("classic_ats");

    expect(html).toContain("@page");
    expect(html).toContain("size: Letter;");
    expect(html).toContain("grid-template-columns: 1fr;");
    expect(html).toMatch(
      /h4 \{(?=[^}]*display: grid;)(?=[^}]*grid-template-columns:)[^}]*}/,
    );
    expect(html).toMatch(
      /\.entry-meta \{(?=[^}]*color: var\(--muted\);)(?=[^}]*font-size: 0\.84rem;)(?=[^}]*font-weight: 500;)[^}]*}/,
    );
    expect(html).toContain('data-ats-safe="true"');
    expect(html).toContain("header-classic");
    expect(html).toContain("section-cluster-classic-intro");
    expect(html).toContain("Alex &lt;Vanguard&gt;");
    expect(html).toContain(
      "Improved designer-engineer handoff &lt;quality&gt; by 30%.",
    );
    expect(html).toContain(
      '<span class="entry-primary"><span>Senior systems designer</span> <span aria-hidden="true">—</span> <span>Signal Systems</span></span>',
    );
    expect(html).toContain(
      '<span class="entry-meta"><span>London, UK</span> <span aria-hidden="true">·</span> <span>Jan 2020 – Present</span></span>',
    );
    expect(html).toContain("alex.example.com");
    expect(html).not.toContain("https://alex.example.com");
    expect(html).toContain("<h3>Summary</h3>");
    expect(html).toContain("<h3>Experience</h3>");
    expect(html).toContain("<h3>Skills</h3>");
    expect(html).toContain(
      "<strong>Core:</strong> <span>Figma</span>, <span>Design Systems</span>",
    );
    expect(html).toContain(
      "<strong>Additional:</strong> <span>React</span>, <span>Playwright</span>",
    );
    expect(html.indexOf("<h3>Skills</h3>")).toBeLessThan(
      html.indexOf("<h3>Experience</h3>"),
    );
    expect(html).toContain("<h3>Languages</h3>");
    expect(html).not.toContain("<h3>Core Skills</h3>");
    expect(html).not.toContain("<h3>Additional Skills</h3>");
    expect(html).not.toContain("Targeted Keywords");
    expect(html).not.toContain("Should not render");
    expect(html).not.toContain(
      ".theme-classic_ats .eyebrow { letter-spacing: 0.15em; }",
    );
  });

  test("renders preview targeting attributes for identity, sections, entries, and bullets", () => {
    const previewDocument: ResumeRenderDocument = {
      ...baseRenderDocument,
      sections: baseRenderDocument.sections.map((section) =>
        section.id === "section_experience"
          ? {
              ...section,
              entries: [
                ...section.entries,
                {
                  id: "entry_bullet_only",
                  title: null,
                  subtitle: null,
                  location: null,
                  dateRange: null,
                  startDate: null,
                  endDate: null,
                  isCurrent: false,
                  heading: null,
                  summary: null,
                  bullets: [
                    {
                      id: "entry_bullet_only_1",
                      text: "Lead architect for platform reliability.",
                    },
                  ],
                },
              ],
            }
          : section.id === "section_projects"
            ? {
                ...section,
                entries: section.entries.map((entry) => ({
                  ...entry,
                  title: null,
                  subtitle: null,
                  heading: "Workflow OS — Design lead",
                })),
              }
            : section,
      ),
    };
    const html = renderTemplate(
      "classic_ats",
      previewDocument,
      "inter_requisite",
      { mode: "preview" },
    );

    expect(html).toContain('data-resume-target-id="identity:fullName"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-resume-target-id="identity:email"');
    expect(html).toContain('data-resume-target-id="identity:portfolioUrl"');
    expect(html).toContain('data-resume-section-id="section_summary"');
    expect(html).toContain(
      'data-resume-target-id="section:section_summary:text"',
    );
    expect(html).toContain('data-resume-entry-id="entry_1"');
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_1:title"',
    );
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_1:subtitle"',
    );
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_1:location"',
    );
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_1:startDate"',
    );
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_1:bullet:entry_1_bullet_1"',
    );
    expect(html).toContain('data-resume-entry-id="entry_bullet_only"');
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_bullet_only:bullet:entry_bullet_only_1"',
    );
    expect(html).toContain("Lead architect for platform reliability.");
    expect(html).toContain(
      'data-resume-target-id="entry:section_projects:project_1:title"',
    );
    expect(html).toContain("Workflow OS — Design lead");
    expect(html).toContain(
      'data-resume-target-id="section:section_skills:bullet:skill_1"',
    );
    expect(html).toContain(
      'data-resume-target-id="section:section_languages:bullet:lang_1"',
    );
  });

  test("renders a single graduation year instead of a duplicate year range", () => {
    const graduationYearDocument: ResumeRenderDocument = {
      ...credentialHeavyRenderDocument,
      sections: credentialHeavyRenderDocument.sections.map((section) =>
        section.id === "section_education"
          ? {
              ...section,
              entries: section.entries.map((entry) => ({
                ...entry,
                dateRange: "2021 – 2021",
                startDate: "2021",
                endDate: "2021",
              })),
            }
          : section,
      ),
    };

    const html = renderTemplate("classic_ats", graduationYearDocument);

    expect(html).toContain(">2021<");
    expect(html).not.toContain("2021 – 2021");
  });

  test("omits blank headline markup when the profile headline is missing", () => {
    const html = renderTemplate("classic_ats", {
      ...baseRenderDocument,
      headline: null,
    });

    expect(html).not.toContain('class="headline"');
  });

  test("renders senior brief with executive header treatment and denser chronology", () => {
    const html = renderTemplate(
      "compact_exec",
      baseRenderDocument,
      "space_grotesk_display",
    );

    expect(html).toContain("page-compact");
    expect(html).toContain("body-grid-compact");
    expect(html).toContain("header-executive");
    expect(html).toContain("meta-pill-list");
    expect(html).toContain("section-dense-chronology");
    expect(html).toContain(
      "'Space Grotesk', 'Trebuchet MS', 'Segoe UI', sans-serif",
    );
    expect(html).toContain("grid-template-columns: 1fr;");
    expect(html).toContain("break-inside: avoid;");
  });

  test("renders materially distinct family structures for accent, technical, and portfolio layouts", () => {
    const accentHtml = renderTemplate("modern_split");
    const technicalHtml = renderTemplate("technical_matrix");
    const portfolioHtml = renderTemplate("project_showcase");

    expect(accentHtml).toContain("header-swiss-accent");
    expect(accentHtml).toContain("section-summary-accent");
    expect(accentHtml).toContain("section-project-spotlight");

    expect(technicalHtml).toContain("header-spec-shell");
    expect(technicalHtml).toContain("meta-stack");
    expect(technicalHtml).toContain("section-spec-shell");
    expect(technicalHtml.indexOf("<h3>Skills</h3>")).toBeLessThan(
      technicalHtml.indexOf("<h3>Summary</h3>"),
    );
    expect(technicalHtml.indexOf("<h3>Summary</h3>")).toBeLessThan(
      technicalHtml.indexOf("<h3>Experience</h3>"),
    );

    expect(portfolioHtml).toContain("header-portfolio");
    expect(portfolioHtml).toContain("section-portfolio-highlight");
    expect(portfolioHtml).toContain("section-portfolio-skills");
    expect(portfolioHtml.indexOf("<h3>Projects</h3>")).toBeLessThan(
      portfolioHtml.indexOf("<h3>Summary</h3>"),
    );
    expect(portfolioHtml.indexOf("<h3>Summary</h3>")).toBeLessThan(
      portfolioHtml.indexOf("<h3>Experience</h3>"),
    );
  });

  test("renders formal proof variant with certification and education spotlight ahead of summary and experience", () => {
    const html = renderTemplate(
      "credentials_focus",
      credentialHeavyRenderDocument,
    );

    expect(html).toContain("header-executive-credentials");
    expect(html).toContain("section-credential-spotlight");
    expect(html).toContain("section-credential-spotlight-surface");

    const certificationsIndex = html.indexOf("<h3>Certifications</h3>");
    const educationIndex = html.indexOf("<h3>Education</h3>");
    const summaryIndex = html.indexOf("<h3>Summary</h3>");
    const experienceIndex = html.indexOf("<h3>Experience</h3>");

    expect(certificationsIndex).toBeGreaterThan(-1);
    expect(educationIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(experienceIndex).toBeGreaterThan(-1);
    expect(certificationsIndex).toBeLessThan(summaryIndex);
    expect(educationIndex).toBeLessThan(summaryIndex);
    expect(summaryIndex).toBeLessThan(experienceIndex);
  });

  test("renders long-history and career-pivot templates with distinct apply-safe structures", () => {
    const longformHtml = renderTemplate(
      "timeline_longform",
      credentialHeavyRenderDocument,
    );
    const pivotHtml = renderTemplate(
      "career_pivot",
      credentialHeavyRenderDocument,
    );

    expect(longformHtml).toContain("header-longform");
    expect(longformHtml).toContain("career-snapshot");
    expect(longformHtml).toContain("section-longform-chronology");
    expect(longformHtml).toContain("<h3>Career Snapshot</h3>");
    expect(longformHtml.indexOf("<h3>Career Snapshot</h3>")).toBeLessThan(
      longformHtml.indexOf("<h3>Experience</h3>"),
    );

    expect(pivotHtml).toContain("header-pivot");
    expect(pivotHtml).toContain("section-pivot-bridge");
    expect(pivotHtml).toContain("section-pivot-proof");
    expect(pivotHtml.indexOf("<h3>Summary</h3>")).toBeLessThan(
      pivotHtml.indexOf("<h3>Projects</h3>"),
    );
    expect(pivotHtml.indexOf("<h3>Projects</h3>")).toBeLessThan(
      pivotHtml.indexOf("<h3>Experience</h3>"),
    );
  });

  test("keeps credential content out of the longform career snapshot counts", () => {
    const bulletOnlyCredentialsDocument: ResumeRenderDocument = {
      ...credentialHeavyRenderDocument,
      sections: credentialHeavyRenderDocument.sections.map((section) =>
        section.id === "section_certifications"
          ? {
              ...section,
              entries: [],
              bullets: [{ id: "cert_bullet", text: "AWS Certified Developer" }],
            }
          : section.id === "section_education"
            ? {
                ...section,
                entries: [],
                bullets: [
                  { id: "edu_bullet", text: "MSc Human Computer Interaction" },
                ],
              }
            : section,
      ),
    };
    const html = renderTemplate(
      "timeline_longform",
      bulletOnlyCredentialsDocument,
    );

    expect(html).toContain("<h3>Career Snapshot</h3>");
    expect(html).not.toContain("Proof item");
    expect(html).not.toContain("Proof items");
  });

  test("keeps internal template branding out of candidate-facing resume content", () => {
    const templateIds: ResumeTemplateId[] = [
      "classic_ats",
      "compact_exec",
      "modern_split",
      "technical_matrix",
      "project_showcase",
      "credentials_focus",
      "timeline_longform",
      "career_pivot",
    ];
    const internalLabels = [
      "Career Pivot Bridge",
      "Modern Editorial",
      "Engineering Spec",
      "Proof Portfolio",
      "Senior Brief",
      "Formal Proof",
      "Longform Timeline",
    ];

    for (const templateId of templateIds) {
      const html = renderTemplate(templateId, credentialHeavyRenderDocument);

      for (const internalLabel of internalLabels) {
        expect(html).not.toContain(`>${internalLabel}<`);
      }
    }
  });

  test("gives every framed resume document a script-free content policy", () => {
    const policy =
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:;\" />";
    const framedDocuments = [
      renderTemplate("classic_ats", baseRenderDocument, "inter_requisite", {
        mode: "preview",
      }),
      renderResumeTemplateCatalogPreviewHtml("classic_ats"),
      renderResumeTemplateCatalogPreviewHtml("classic_ats", {
        layout: "panel",
      }),
    ];

    for (const html of framedDocuments) {
      // The studio preview and the template catalog render these documents in
      // a srcdoc iframe with no sandbox attribute, so the document itself must
      // refuse script and every network fetch.
      expect(html).toContain(policy);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    }

    // The exported/print document is not framed and is left byte-identical.
    expect(renderTemplate("classic_ats")).not.toContain(
      "Content-Security-Policy",
    );
  });

  test("keeps work-history review guidance out of rendered resume HTML", () => {
    const html = renderTemplate("classic_ats");

    expect(html).not.toContain("weaker career-family fit");
  });

  test("renders catalog preview shell from the shared renderer for every shipped template", () => {
    for (const template of listLocalResumeTemplates()) {
      const html = renderResumeTemplateCatalogPreviewHtml(template.id);

      expect(html).toContain('class="catalog-body catalog-body-thumbnail"');
      expect(html).toContain("catalog-body-thumbnail");
      expect(html).toContain("catalog-shell");
      expect(html).toContain("transform: scale(0.23);");
      expect(html).toContain('data-ats-safe="true"');
      expect(html).toContain(`content="${template.label}"`);
    }
  });

  test("renders panel catalog preview shell when requested", () => {
    const html = renderResumeTemplateCatalogPreviewHtml("classic_ats", {
      layout: "panel",
    });

    expect(html).toContain("catalog-body-panel");
    expect(html).toContain("catalog-shell-panel");
    expect(html).toContain("John Doe");
    expect(html).toContain("Senior platform engineer");
    expect(html).toContain("AWS Certified Developer");
    expect(html).toContain(
      "--catalog-scale: min(1, calc((100vw - 0.45rem) / 8.5in));",
    );
    expect(html).toContain('data-ats-safe="true"');
  });

  test("renders every shipped template with ATS-safe single-column structure", () => {
    for (const template of listLocalResumeTemplates()) {
      const html = renderTemplate(template.id);

      expect(html).toContain("@page");
      expect(html).toContain("grid-template-columns: 1fr;");
      const gridTemplateColumnValues = [
        ...html.matchAll(
          /\.body-grid\s*\{[^}]*grid-template-columns:\s*([^;]+);/g,
        ),
      ].map((match) => match[1]?.trim());
      expect(gridTemplateColumnValues).toEqual(expect.arrayContaining(["1fr"]));
      expect(gridTemplateColumnValues.every((value) => value === "1fr")).toBe(
        true,
      );
      expect(html).not.toContain("<table");
      expect(html).not.toContain("data-resume-section-id=");
      expect(html).not.toContain("data-resume-entry-id=");
      expect(html).not.toContain("data-resume-target-id=");
      expect(html).toContain(`content="${template.label}"`);
    }
  });

  test("keeps long contact tokens within the page and repeats existing template margins in print", () => {
    const margins = {
      classic: "0.52in 0.62in",
      compact: "0.44in 0.54in",
      modern: "0.54in 0.64in",
      technical: "0.48in 0.58in",
      projects: "0.56in 0.66in",
      credentials: "0.52in 0.64in",
      longform: "0.4in 0.52in",
      pivot: "0.52in 0.64in",
    };
    for (const template of listLocalResumeTemplates()) {
      const html = renderTemplate(template.id);
      const family = /class="page page-([a-z]+)/.exec(html)?.[1];
      expect(family).toBeDefined();
      const margin = margins[family as keyof typeof margins];
      expect(html).toContain(`@page resume-${family} { margin: ${margin}; }`);
      expect(html).toContain(`.page-${family} { page: resume-${family}; }`);
      expect(html).toContain("overflow-wrap: anywhere;");
      expect(html).toContain(".page * { min-width: 0; }");
      expect(html).toContain(".page { width: auto; min-height: 0; padding: 0;");
    }
  });

  test("keeps exported resumes flat, typeset, and print-ready across every family", () => {
    for (const template of listLocalResumeTemplates()) {
      const html = renderTemplate(template.id);

      expect(html).toContain("-webkit-print-color-adjust: exact;");
      expect(html).toContain("@media print");
      expect(html).toContain("break-inside: avoid;");
      expect(html).toContain("page-break-inside: avoid;");
      expect(html).not.toContain("border-radius:");
      expect(html).not.toContain("border-style: dashed;");
      expect(html).not.toContain("border-radius: 999px;");
      expect(html).not.toContain("background: linear-gradient");
    }
  });

  test("ships restrained, distinct print accents for all eight resume systems", () => {
    const html = renderTemplate("classic_ats");

    expect(html).toContain("--resume-classic-accent: #1f2933;");
    expect(html).toContain("--resume-compact-accent: #182433;");
    expect(html).toContain("--resume-modern-accent: #145c63;");
    expect(html).toContain("--resume-technical-accent: #234d72;");
    expect(html).toContain("--resume-projects-accent: #6a3e55;");
    expect(html).toContain("--resume-credentials-accent: #4a3f2c;");
    expect(html).toContain("--resume-longform-accent: #30343a;");
    expect(html).toContain("--resume-pivot-accent: #365947;");
    expect(html).toContain(
      ".theme-classic_ats { --accent: var(--resume-classic-accent);",
    );
    expect(html).toContain(
      ".theme-compact_exec { --accent: var(--resume-compact-accent);",
    );
    expect(html).toContain(
      ".theme-modern_split { --accent: var(--resume-modern-accent);",
    );
    expect(html).toContain(
      ".theme-technical_matrix { --accent: var(--resume-technical-accent);",
    );
    expect(html).toContain(
      ".theme-project_showcase { --accent: var(--resume-projects-accent);",
    );
    expect(html).toContain(
      ".theme-credentials_focus { --accent: var(--resume-credentials-accent);",
    );
    expect(html).toContain(
      ".theme-timeline_longform { --accent: var(--resume-longform-accent);",
    );
    expect(html).toContain(
      ".theme-career_pivot { --accent: var(--resume-pivot-accent);",
    );
  });

  test("lets multi-entry sections paginate while keeping each entry together", () => {
    const experienceSection = baseRenderDocument.sections.find(
      (section) => section.id === "section_experience",
    )!;
    const firstEntry = experienceSection.entries[0]!;
    const html = renderTemplate("timeline_longform", {
      ...baseRenderDocument,
      sections: baseRenderDocument.sections.map((section) =>
        section.id === "section_experience"
          ? {
              ...section,
              entries: [
                firstEntry,
                {
                  ...firstEntry,
                  id: "entry_2",
                  title: "Systems designer",
                  dateRange: "Jan 2017 – Dec 2019",
                  startDate: "2017-01",
                  endDate: "2019-12",
                  isCurrent: false,
                  bullets: [
                    {
                      id: "entry_2_bullet_1",
                      text: "Built durable workflow foundations.",
                    },
                  ],
                },
              ],
            }
          : section,
      ),
    });

    expect(html.match(/class="entry-block"/g)).toHaveLength(3);
    expect(html).toContain(
      ".header, .entry-block, h3, h4, .skill-group { break-inside: avoid; page-break-inside: avoid; }",
    );
    expect(html).not.toContain(".header, .section-block, .entry-block");
  });

  test("keeps preview selection affordances precise without changing export markup", () => {
    const previewHtml = renderTemplate(
      "technical_matrix",
      baseRenderDocument,
      "inter_requisite",
      {
        mode: "preview",
      },
    );
    const exportHtml = renderTemplate("technical_matrix");

    expect(previewHtml).toContain(
      "box-shadow: 0 0 0 1px var(--resume-selected-shadow);",
    );
    expect(previewHtml).toContain("border-radius: 0.02in;");
    expect(exportHtml).not.toContain("data-resume-target-id=");
    expect(exportHtml).not.toContain("border-radius:");
  });
});

describe("job finder resume paper surface", () => {
  test("prints the page on white paper in preview and export, never an app surface", () => {
    for (const mode of ["preview", "export"] as const) {
      const html = renderTemplate(
        "classic_ats",
        baseRenderDocument,
        "inter_requisite",
        { mode },
      );

      expect(html).toContain("--resume-paper: #ffffff;");
      expect(html).not.toContain("--resume-paper: var(--card");
      expect(html).toMatch(/\.page \{[^}]*background: var\(--resume-paper\)/);
      expect(html).toContain("--ink: #202124;");
    }
  });

  test("keeps the preview page on paper with a shadow while the pane stays tinted", () => {
    const html = renderTemplate(
      "classic_ats",
      baseRenderDocument,
      "inter_requisite",
      { mode: "preview" },
    );

    expect(html).toMatch(
      /\.preview-body \.page \{[\s\S]*?background: var\(--resume-paper\);[\s\S]*?box-shadow:/,
    );
    expect(html).toContain(
      "--resume-preview-canvas: var(--surface-muted, #e7edf6);",
    );
  });

  test("outlines a linked entry instead of filling it with a highlight band", () => {
    const html = renderTemplate(
      "classic_ats",
      baseRenderDocument,
      "inter_requisite",
      { mode: "preview" },
    );

    expect(html).toContain("--resume-selected-surface: transparent;");
    expect(html).toContain("--resume-hover-surface: transparent;");
  });
});

describe("job finder resume renderer narrative presentation", () => {
  // The list style paints its own marker inside <style>; only body markup counts.
  function bodyMarkup(html: string): string {
    return html.replace(/<style[\s\S]*?<\/style>/g, "");
  }

  function withEntrySummary(
    summary: string,
    bullets: Array<{ id: string; text: string }> = [],
  ): ResumeRenderDocument {
    return {
      ...baseRenderDocument,
      sections: baseRenderDocument.sections.map((section) =>
        section.id === "section_experience"
          ? {
              ...section,
              entries: section.entries.map((entry) => ({
                ...entry,
                summary,
                bullets,
              })),
            }
          : section,
      ),
    };
  }

  test("splits an inline glyph list in a legacy entry summary into bullets and never prints a glyph", () => {
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary(
        "Owns the checkout platform. ● Cut p95 latency by 40% ● Introduced contract tests ● Mentored two juniors",
      ),
      "inter_requisite",
      { mode: "preview" },
    );

    expect(bodyMarkup(html)).not.toMatch(/[●•▪◦‣]/);
    expect(html).toContain("<li");
    expect(html).toContain("Cut p95 latency by 40%.");
    expect(html).toContain("Introduced contract tests.");
    expect(html).toContain("Mentored two juniors.");
    expect(html).toContain("Owns the checkout platform.</p>");
    // Derived bullets keep the summary as their editor target.
    expect(html).toContain(
      'data-resume-target-id="entry:section_experience:entry_1:summary"',
    );
    expect(html).not.toContain("bullet:summary-line-1");
  });

  test("turns a three-sentence summary with no bullets into a lead sentence plus bullets", () => {
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary(
        "Led the data platform. Migrated 40 pipelines to Airflow. Reduced on-call pages by half.",
      ),
    );

    expect(html).toContain("Led the data platform.</p>");
    expect(html).toContain("<li>Migrated 40 pipelines to Airflow.</li>");
    expect(html).toContain("<li>Reduced on-call pages by half.</li>");
  });

  test("preserves terminal punctuation from non-Latin scripts", () => {
    const texts = [
      "顧客対応と資料管理を担当しました。",
      "负责客户支持和文档管理。",
      "هل راجعت السجلات؟",
      "محفوظ ریکارڈ۔",
    ];
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary(
        "Owns the platform.",
        texts.map((text, index) => ({ id: `bullet_${index}`, text })),
      ),
    );
    for (const text of texts) expect(html).toContain(`<li>${text}</li>`);
  });

  test("normalizes split .NET tokens and missing list spacing in bullets", () => {
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary("Owns the platform.", [
        { id: "b1", text: "Built ASP .NET Core REST APIs with C#,.NET." },
        { id: "b2", text: "Developed microservices with ASP .Net Core" },
      ]),
    );

    expect(html).toContain("Built ASP.NET Core REST APIs with C#, .NET.");
    expect(html).toContain("Developed microservices with ASP.Net Core.");
    expect(html).not.toContain("ASP .NET");
    expect(html).not.toContain("C#,.NET");
  });

  test("applies the same token spacing and terminal period to the summary paragraph", () => {
    const html = renderTemplate("classic_ats", {
      ...baseRenderDocument,
      sections: [
        {
          ...baseRenderDocument.sections[0]!,
          text: "Backend engineer with C#,.NET, ASP .NET Core, TDD, and DevOps discipline",
        },
        ...baseRenderDocument.sections.slice(1),
      ],
    });

    // The summary paragraph was the one text block that skipped the shared
    // normalization, so it printed "C#,.NET" and ended without a period while
    // every bullet beneath it was already clean.
    expect(html).toContain(
      "Backend engineer with C#, .NET, ASP.NET Core, TDD, and DevOps discipline.</p>",
    );
    expect(html).not.toContain("C#,.NET");
    expect(html).not.toContain("ASP .NET");
  });

  test("never shows a thousands separator as a list comma", () => {
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary("Owns the platform.", [
        { id: "b1", text: "Served 1,200,000 monthly requests." },
      ]),
    );

    expect(html).toContain("Served 1,200,000 monthly requests.");
  });

  test("gives every rendered bullet terminal punctuation", () => {
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary("Owns the platform.", [
        { id: "b1", text: "Shipped the release pipeline" },
        { id: "b2", text: "Reduced flake rate by half." },
        { id: "b3", text: "Did the team ship it?" },
      ]),
    );

    expect(html).toContain("<li>Shipped the release pipeline.</li>");
    expect(html).toContain("<li>Reduced flake rate by half.</li>");
    expect(html).toContain("<li>Did the team ship it?</li>");
  });

  test("keeps a multi-sentence summary as prose when the entry already has real bullets", () => {
    const html = renderTemplate(
      "classic_ats",
      withEntrySummary(
        "Led the data platform. Migrated 40 pipelines to Airflow. Reduced on-call pages by half.",
        [
          { id: "b1", text: "• Cut costs by 20%." },
          { id: "b2", text: "Hired four engineers." },
        ],
      ),
    );

    expect(html).toContain(
      "Led the data platform. Migrated 40 pipelines to Airflow. Reduced on-call pages by half.</p>",
    );
    expect(html).toContain("<li>Cut costs by 20%.</li>");
    expect(bodyMarkup(html)).not.toMatch(/[●•▪◦‣]/);
  });
});
