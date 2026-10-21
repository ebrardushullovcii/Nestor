import {
  ResumeResearchArtifactSchema,
  type ResumeResearchArtifact,
  type SavedJob,
} from "@nestor/contracts";
import {
  extractReadablePage,
  extractResearchSignals,
} from "@nestor/knowledge-base";
import type {
  ResumeResearchAdapter,
  ResumeResearchAdapterInput,
} from "@nestor/job-finder";

interface CreateDesktopResumeResearchAdapterOptions {
  fetchImpl?: typeof fetch;
  maxPages?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

interface ReadableResearchPage {
  title: string | null;
  text: string;
}

interface ResearchSignals {
  companyNotes: string | null;
  domainVocabulary: string[];
  priorityThemes: string[];
}

export function createDesktopResumeResearchAdapter(
  options: CreateDesktopResumeResearchAdapterOptions = {},
): ResumeResearchAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxPages = options.maxPages ?? 3;
  const maxBytes = options.maxBytes ?? 250_000;
  const timeoutMs = options.timeoutMs ?? 6_000;

  return {
    async fetchResearchPages(input) {
      const typedInput: ResumeResearchAdapterInput = input;
      const candidateUrls = buildCandidateResearchUrls(typedInput.job).slice(
        0,
        maxPages,
      );
      const artifacts: ResumeResearchArtifact[] = [];
      // The pages are fetched together and read in order: one after another,
      // three slow or missing pages held the resume back up to 18 seconds.
      const responses = candidateUrls.map((sourceUrl) =>
        fetchPage(sourceUrl, fetchImpl, timeoutMs, maxBytes).then(
          (text) => ({ ok: true as const, text }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );

      for (const [index, sourceUrl] of candidateUrls.entries()) {
        try {
          const response = await responses[index]!;
          if (!response.ok) throw response.error;
          const responseText = response.text;
          const readable = normalizeReadableResearchPage(
            extractReadablePage({
              url: sourceUrl,
              html: responseText,
            }),
          );
          const signals = normalizeResearchSignals(
            extractResearchSignals(readable.text),
          );

          artifacts.push({
            id: `resume_research_${typedInput.job.id}_${artifacts.length + 1}`,
            jobId: typedInput.job.id,
            sourceUrl,
            pageTitle: readable.title,
            fetchedAt: new Date().toISOString(),
            extractedText: readable.text || null,
            companyNotes: signals.companyNotes,
            domainVocabulary: [...signals.domainVocabulary],
            priorityThemes: [...signals.priorityThemes],
            fetchStatus: "success",
          });
        } catch (error) {
          console.warn(
            `[ResumeResearch] Failed to fetch research page for job ${typedInput.job.id} from ${sourceUrl}.`,
            error instanceof Error ? (error.stack ?? error.message) : error,
          );
          artifacts.push({
            id: `resume_research_${typedInput.job.id}_${artifacts.length + 1}`,
            jobId: typedInput.job.id,
            sourceUrl,
            pageTitle: null,
            fetchedAt: new Date().toISOString(),
            extractedText: null,
            companyNotes:
              error instanceof Error && error.message.trim().length > 0
                ? `Fetch failed: ${error.message}`
                : null,
            domainVocabulary: [],
            priorityThemes: [],
            fetchStatus: "failed",
          });
        }
      }

      return ResumeResearchArtifactSchema.array().parse(artifacts);
    },
  };
}

const jobBoardHostFragments = [
  "linkedin.com",
  "indeed.com",
  "greenhouse.io",
  "lever.co",
  "workday.com",
  "ashbyhq.com",
  "smartrecruiters.com",
];

async function fetchPage(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Nestor Resume Workspace Research/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Research fetch failed with status ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Research fetch returned no body.");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        throw new Error(`Research fetch exceeded the ${maxBytes}-byte limit.`);
      }

      chunks.push(value);
    }

    return new TextDecoder().decode(joinChunks(chunks, totalBytes));
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Ignore cleanup failures after the stream already closed.
    }
    clearTimeout(timeoutId);
  }
}

function buildCandidateResearchUrls(job: SavedJob): string[] {
  const employerRoot = deriveEmployerRoot(job);
  if (!employerRoot) {
    return [];
  }

  return [
    employerRoot,
    `${employerRoot}/about`,
    `${employerRoot}/careers`,
    `${employerRoot}/company`,
  ];
}

function deriveEmployerRoot(job: SavedJob): string | null {
  const explicitEmployerOrigin = toSafeResearchOrigin(
    job.employerWebsiteUrl ?? "",
  );
  if (explicitEmployerOrigin) {
    return explicitEmployerOrigin;
  }

  const canonicalOrigin = toSafeResearchOrigin(job.canonicalUrl);
  const canonicalHost = safeHostname(job.canonicalUrl);
  if (
    canonicalOrigin &&
    canonicalHost &&
    !isLikelyJobBoardHost(canonicalHost)
  ) {
    return canonicalOrigin;
  }

  const employerDomain = job.employerDomain?.trim().toLowerCase() ?? null;
  if (
    employerDomain &&
    !isLikelyJobBoardHost(employerDomain) &&
    !isPrivateOrLoopbackHostname(employerDomain)
  ) {
    return `https://${employerDomain}`;
  }

  return null;
}

function joinChunks(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLikelyJobBoardHost(hostname: string): boolean {
  return jobBoardHostFragments.some(
    (fragment) => hostname === fragment || hostname.endsWith(`.${fragment}`),
  );
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    return true;
  }

  if (
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    return true;
  }

  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) {
    return true;
  }

  return (
    /^f[c-d][0-9a-f:]*$/i.test(hostname) ||
    /^fe[89ab][0-9a-f:]*$/i.test(hostname)
  );
}

function toSafeResearchOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      isLikelyJobBoardHost(hostname) ||
      isPrivateOrLoopbackHostname(hostname)
    ) {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizeReadableResearchPage(
  value: ReturnType<typeof extractReadablePage>,
): ReadableResearchPage {
  if (!value || typeof value !== "object") {
    throw new Error("Readable research page result was invalid.");
  }

  return {
    title: typeof value.title === "string" ? value.title : null,
    text: typeof value.text === "string" ? value.text : "",
  };
}

function normalizeResearchSignals(
  value: ReturnType<typeof extractResearchSignals>,
): ResearchSignals {
  if (!value || typeof value !== "object") {
    throw new Error("Research signals result was invalid.");
  }

  return {
    companyNotes:
      typeof value.companyNotes === "string" ? value.companyNotes : null,
    domainVocabulary: Array.isArray(value.domainVocabulary)
      ? value.domainVocabulary.filter(
          (entry: unknown): entry is string => typeof entry === "string",
        )
      : [],
    priorityThemes: Array.isArray(value.priorityThemes)
      ? value.priorityThemes.filter(
          (entry: unknown): entry is string => typeof entry === "string",
        )
      : [],
  };
}
