import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createJobFinderAiClientFromEnvironment,
  createResumeVisionProviderFromEnvironment,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  ResumeImportBenchmarkCaseSchema,
  ResumeImportBenchmarkRequestSchema,
  type CandidateProfile,
  type JobSearchPreferences,
  type ResumeDocumentBundle,
  type ResumeImportBenchmarkCase,
  type ResumeImportBenchmarkReport,
  type ResumeImportBenchmarkRequest,
} from "@nestor/contracts";
import {
  buildBenchmarkAiClient,
  runResumeImportBenchmark,
} from "@nestor/job-finder";

import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { extractResumeDocument } from "../../adapters/resume-document";
import { detectResumeDocumentFileKind } from "../../adapters/resume-document/worker";
import { generateResumeVisionImages } from "../../adapters/resume-vision-images";

const defaultBenchmarkCases = [
  {
    id: "resume_import_comprehensive_txt",
    label: "Comprehensive structured text canary",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-comprehensive-sample.txt",
    canary: true,
    tags: ["txt", "canary", "dates", "projects", "certifications", "languages"],
    expected: {
      literalFields: {
        fullName: "Morgan Lee",
        currentLocation: "Amsterdam, Netherlands",
        email: "morgan.lee@example.test",
        phone: "+31 20 555 0199",
      },
      summaryContains: ["reliable workflow software"],
      experienceRecords: [
        {
          title: "Senior Product Engineer",
          companyName: "Northstar Labs",
          location: "Amsterdam, Netherlands",
          startDate: "2022-03",
          endDate: null,
          isCurrent: true,
          achievements: [
            "Reduced manual review time by 28% through a guided validation queue.",
            "Led an accessibility remediation that reached WCAG 2.2 AA on core flows.",
          ],
        },
        {
          title: "Frontend Engineer",
          companyName: "Harbor Studio",
          location: "Rotterdam, Netherlands",
          startDate: "2019-01",
          endDate: "2022-02",
          isCurrent: false,
          achievements: [
            "Shipped a reusable component library across four products.",
          ],
        },
      ],
      educationRecords: [
        {
          schoolName: "Delft University of Technology",
          degree: "BSc Computer Science",
        },
      ],
      projectRecords: [
        {
          name: "Queue Insight",
          role: "Lead Developer",
        },
      ],
      certificationRecords: [
        {
          name: "AWS Certified Developer - Associate",
          issuer: "Amazon Web Services",
        },
      ],
      languageRecords: [
        { language: "English", proficiency: "Professional working proficiency" },
        { language: "Dutch", proficiency: "Native" },
      ],
      forbiddenProfileText: [
        "PhD",
        "Spanish - Native",
        "managed 50 engineers",
      ],
    },
  },
  {
    id: "resume_import_sample_txt",
    label: "Deterministic text canary",
    resumePath: "apps/desktop/test-fixtures/job-finder/resume-import-sample.txt",
    canary: true,
    tags: ["txt", "canary"],
    expected: {
      literalFields: {
        fullName: "Jamie Rivers",
        currentLocation: "Berlin, Germany",
        email: "jamie@example.com",
        phone: "+49 555 0000000",
      },
      summaryContains: ["12 years of experience"],
      experienceRecords: [
        {
          title: "Staff Frontend Engineer",
          companyName: "Signal Systems",
        },
      ],
      educationRecords: [],
    },
  },
  {
    id: "persona_lina_txt",
    label: "Lina, data student (txt)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/lina-haddad.txt",
    canary: false,
    tags: ["txt"],
    expected: {
      literalFields: {
        fullName: "Lina Haddad",
        currentLocation: "Berlin, Germany",
        email: "lina.haddad@example.com",
        phone: "+49 151 5550 1234",
      },
      summaryContains: [],
      experienceRecords: [
        {
          title: "Working Student, Data Analytics",
          companyName: "Mobilo GmbH",
          startDate: "2024-10",
          isCurrent: true,
        },
        {
          title: "Research Assistant",
          companyName: "TU Berlin",
          startDate: "2024-04",
          endDate: "2024-09",
        },
        {
          title: "Intern, Business Intelligence",
          companyName: "Byblos Retail Group",
          startDate: "2022-06",
          endDate: "2022-09",
        },
      ],
      educationRecords: [
        {
          schoolName: "Technische Universität Berlin",
          degree: "M.Sc. Data Science",
        },
        {
          schoolName: "American University of Beirut",
          degree: "B.Sc. Statistics",
        },
      ],
      languageRecords: [
        {
          language: "English",
        },
        {
          language: "Arabic",
        },
        {
          language: "German",
        },
      ],
      forbiddenProfileText: ["University of Beirut, Beirut"],
    },
  },
  {
    id: "persona_priya_pdf",
    label: "Priya, product designer (pdf)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/priya-raman.pdf",
    canary: true,
    tags: ["pdf"],
    expected: {
      literalFields: {
        fullName: "Priya Raman",
        currentLocation: "London, UK",
        email: "priya.raman@example.com",
        phone: "+44 20 7946 0958",
      },
      summaryContains: ["8 years"],
      experienceRecords: [
        {
          title: "Freelance Product Designer",
          companyName: "Raman Studio",
          startDate: "2023",
          isCurrent: true,
        },
        {
          title: "Senior Product Designer",
          companyName: "Penny Bank",
          startDate: "2019",
          endDate: "2023",
        },
        {
          title: "Product Designer",
          companyName: "CareLoop Health",
          startDate: "2016",
          endDate: "2019",
        },
      ],
      educationRecords: [
        {
          schoolName: "Central Saint Martins",
          degree: "BA (Hons) Graphic Communication Design",
        },
      ],
    },
  },
  {
    id: "persona_dev_pdf",
    label: "Dev, backend engineer (pdf, wrapped lines)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/dev-castellano.pdf",
    canary: true,
    tags: ["pdf"],
    expected: {
      literalFields: {
        fullName: "Dev Castellano",
        currentLocation: "Austin, TX",
        email: "dev.castellano@example.com",
        phone: "+1 512 555 0199",
      },
      summaryContains: ["11 years"],
      experienceRecords: [
        {
          title: "Senior Software Engineer, Payments Platform",
          companyName: "Lattice Pay",
          startDate: "2021-03",
          isCurrent: true,
        },
        {
          title: "Software Engineer II",
          companyName: "Corvid Logistics",
          startDate: "2017-06",
          endDate: "2021-02",
        },
        {
          title: "Software Engineer",
          companyName: "Brightwater Labs",
          startDate: "2014-07",
          endDate: "2017-05",
        },
      ],
      educationRecords: [
        {
          schoolName: "Texas A&M University",
          degree: "B.S. Computer Science",
        },
      ],
      forbiddenProfileText: ["Kubern", "dev-caste"],
    },
  },
  {
    id: "persona_maya_docx",
    label: "Maya, teacher to instructional design (docx)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/maya-okafor.docx",
    canary: false,
    tags: ["docx"],
    expected: {
      literalFields: {
        fullName: "Maya Okafor",
        email: "maya.okafor@example.com",
        phone: "(614) 555-0142",
      },
      summaryContains: ["9 years"],
      experienceRecords: [
        {
          title: "Science Teacher, Grade 7-8",
          companyName: "Riverbend Middle School",
          startDate: "2016-08",
          isCurrent: true,
        },
        {
          title: "Summer Program Coordinator",
          companyName: "Ohio STEM Camps",
          startDate: "2019-06",
          endDate: "2022-08",
        },
        {
          title: "Student Teacher",
          companyName: "Lincoln Elementary",
          startDate: "2015-01",
          endDate: "2015-05",
        },
      ],
      educationRecords: [
        {
          schoolName: "Ohio State University",
          degree: "Master of Education",
        },
        {
          schoolName: "University of Dayton",
          degree: "Bachelor of Science",
        },
      ],
      certificationRecords: [
        {
          name: "Ohio Professional Teaching License (Grades 4-9 Science)",
        },
        {
          name: "Articulate Storyline Essentials",
        },
      ],
    },
  },
  {
    id: "persona_roberto_md",
    label: "Roberto, operations manager (markdown)",
    resumePath:
      "apps/desktop/test-fixtures/job-finder/resume-import-personas/roberto-almeida.md",
    canary: false,
    tags: ["md"],
    expected: {
      literalFields: {
        fullName: "Roberto Almeida",
        currentLocation: "Porto, Portugal",
        email: "roberto.almeida@example.com",
        phone: "+351 912 555 017",
      },
      summaryContains: ["14 years"],
      experienceRecords: [
        {
          title: "Operations Manager",
          companyName: "Atlântico Logística",
          startDate: "2019-01",
          isCurrent: true,
        },
        {
          title: "Shift Supervisor",
          companyName: "Norte Express",
          startDate: "2013-03",
          endDate: "2018-12",
        },
        {
          title: "Warehouse Associate",
          companyName: "Norte Express",
          startDate: "2010-06",
          endDate: "2013-02",
        },
      ],
      educationRecords: [
        {
          schoolName: "Universidade do Porto",
          degree: "Licenciatura in Management",
        },
      ],
      languageRecords: [
        {
          language: "Portuguese",
        },
        {
          language: "English",
        },
        {
          language: "Spanish",
        },
      ],
      forbiddenProfileText: ["**"],
    },
  },
] satisfies ResumeImportBenchmarkCase[];

function findRepoRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function resolveRepoRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(currentDir) ?? findRepoRoot(process.cwd());

  if (!repoRoot) {
    throw new Error(
      `Could not locate repo root from ${currentDir} or ${process.cwd()}.`,
    );
  }

  return repoRoot;
}

function resolveBenchmarkCases(
  request: ResumeImportBenchmarkRequest,
): ResumeImportBenchmarkCase[] {
  const cases = request.cases.length > 0 ? request.cases : defaultBenchmarkCases;
  return cases.map((benchmarkCase) => ResumeImportBenchmarkCaseSchema.parse(benchmarkCase));
}

function buildBenchmarkProfile(fileName: string): CandidateProfile {
  const emptyState = createEmptyJobFinderRepositoryState();
  return {
    ...emptyState.profile,
    baseResume: {
      ...emptyState.profile.baseResume,
      id: `resume_benchmark_${Date.now()}`,
      fileName,
      uploadedAt: new Date().toISOString(),
    },
  };
}

function buildBenchmarkSearchPreferences(): JobSearchPreferences {
  return createEmptyJobFinderRepositoryState().searchPreferences;
}

function buildAiClient(
  request: ResumeImportBenchmarkRequest,
): JobFinderAiClient {
  if (request.useConfiguredAi) {
    return createJobFinderAiClientFromEnvironment(process.env);
  }

  return buildBenchmarkAiClient(false);
}

async function loadDocumentBundle(input: {
  benchmarkCase: ResumeImportBenchmarkCase;
  profile: CandidateProfile;
  useVision: boolean;
}): Promise<{
  documentBundle: ResumeDocumentBundle;
  parseMethod: string;
  workerManifestVersion: string | null;
  visionArtifact: Awaited<ReturnType<typeof generateResumeVisionImages>>["artifact"] | null;
}> {
  const repoRoot = resolveRepoRoot();
  const resumePath = path.resolve(repoRoot, input.benchmarkCase.resumePath);
  await readFile(resumePath);
  const extracted = await extractResumeDocument(resumePath, {
    bundleId: `benchmark_bundle_${input.benchmarkCase.id}`,
    runId: `benchmark_run_${input.benchmarkCase.id}`,
    sourceResumeId: input.profile.baseResume.id,
  });
  const visionArtifact = input.useVision
    ? await generateResumeVisionImages({
        filePath: resumePath,
        fileKind: detectResumeDocumentFileKind(resumePath),
        runId: `benchmark_run_${input.benchmarkCase.id}`,
        sourceResumeId: input.profile.baseResume.id,
        artifactId: `benchmark_vision_artifact_${input.benchmarkCase.id}`,
        env: process.env,
      }).then((result) => result.artifact)
    : null;

  return {
    documentBundle: extracted.bundle,
    parseMethod: [
      extracted.bundle.parserManifest?.workerKind ?? "unknown_worker",
      extracted.bundle.primaryParserKind,
    ].filter(Boolean).join("+"),
    workerManifestVersion: extracted.bundle.parserManifest?.manifestVersion ?? null,
    visionArtifact,
  };
}

export async function runDesktopResumeImportBenchmark(
  input: Partial<ResumeImportBenchmarkRequest> = {},
): Promise<ResumeImportBenchmarkReport> {
  const parsedInput = ResumeImportBenchmarkRequestSchema.parse({
    ...input,
    cases: input.cases ?? [],
  });
  const request = ResumeImportBenchmarkRequestSchema.parse({
    ...parsedInput,
    cases: resolveBenchmarkCases(parsedInput),
  });

  return runResumeImportBenchmark({
    request,
    async createHarness(benchmarkCase, normalizedRequest) {
      const profile = buildBenchmarkProfile(path.basename(benchmarkCase.resumePath));
      const searchPreferences = buildBenchmarkSearchPreferences();
      const { documentBundle, parseMethod, workerManifestVersion, visionArtifact } = await loadDocumentBundle({
        benchmarkCase,
        profile,
        useVision: normalizedRequest.useVision,
      });

      return {
        profile: {
          ...profile,
          baseResume: {
            ...profile.baseResume,
            textContent: documentBundle.fullText,
            textUpdatedAt: documentBundle.fullText ? new Date().toISOString() : null,
            extractionStatus: documentBundle.fullText ? "ready" : "needs_text",
            storagePath: path.resolve(resolveRepoRoot(), benchmarkCase.resumePath),
          },
        },
        searchPreferences,
        documentBundle,
        aiClient: buildAiClient(normalizedRequest),
        visionProvider: normalizedRequest.useConfiguredAi && normalizedRequest.useVision
          ? createResumeVisionProviderFromEnvironment(process.env)
          : null,
        parseMethod,
        workerManifestVersion,
        ...(normalizedRequest.useVision ? { visionArtifact } : {}),
      };
    },
  });
}

export { defaultBenchmarkCases };
