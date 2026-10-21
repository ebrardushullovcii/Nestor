import { createHash, randomUUID } from "node:crypto";

/**
 * How Job Finder identifies itself to the model gateway.
 *
 * OpenCode Go asks third-party clients for two things: a User-Agent that names
 * the client (not the runtime's generic one) and an `x-opencode-session`
 * header carrying one stable id per conversation, which it uses to route the
 * requests of a conversation to the same upstream for prompt caching. Both
 * are cheap to honor and neither carries personal data: the session id is a
 * hash of a product-side key (a job, a profile, a file), never the key itself.
 *
 * The User-Agent goes to every OpenAI-compatible provider. The session header
 * goes only to OpenCode hosts; other providers never asked for it.
 */

export const JOB_FINDER_MODEL_CLIENT_USER_AGENT =
  "Nestor-JobFinder/0.1 (desktop; https://github.com/ebrardushullovcii/Nestor)";

const OPENCODE_SESSION_HEADER = "x-opencode-session";
const SESSION_ID_PREFIX = "ses_";
const SESSION_ID_BODY_LENGTH = 26;

export function isOpenCodeBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/**
 * A stable, opaque session id for a conversation key. The same key always
 * yields the same id, across restarts, so a conversation about one job keeps
 * one id for as long as that job exists; different keys never collide in
 * practice. Shaped like OpenCode's own ids (`ses_` + 26 characters).
 */
export function buildModelSessionId(conversationKey: string): string {
  const digest = createHash("sha256")
    .update(conversationKey, "utf8")
    .digest("base64url")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
  return `${SESSION_ID_PREFIX}${digest.slice(0, SESSION_ID_BODY_LENGTH)}`;
}

/** A per-process fallback key for requests that belong to no conversation. */
export function createInstanceConversationKey(): string {
  return `instance:${randomUUID()}`;
}

export function buildModelRequestHeaders(input: {
  apiKey: string;
  baseUrl: string;
  conversationKey: string;
  /** `null` leaves the content type to fetch (multipart bodies set their own). */
  contentType?: string | null;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    "User-Agent": JOB_FINDER_MODEL_CLIENT_USER_AGENT,
  };
  if (input.contentType !== null) {
    headers["Content-Type"] = input.contentType ?? "application/json";
  }
  if (isOpenCodeBaseUrl(input.baseUrl)) {
    headers[OPENCODE_SESSION_HEADER] = buildModelSessionId(
      input.conversationKey,
    );
  }
  return headers;
}

/**
 * Conversation keys for each product operation. A conversation is the thing
 * the user is working on, not the request: every draft, revision and edit
 * for one job share a key; every Copilot turn about one profile shares a key;
 * every extraction stage of one imported file shares a key.
 */
export const modelConversationKeys = {
  resumeForJob(job: { source: string; sourceJobId: string }): string {
    return `resume:${job.source}:${job.sourceJobId}`;
  },
  /**
   * Writing a resume from the profile, for any job. The person's evidence and
   * the writer's instructions lead every such request, so one session lets
   * the gateway serve that prefix from its cache across a batch; keyed per
   * job, ten resumes went to ten upstreams and none was cached.
   */
  resumeWriting(profile: { id: string }): string {
    return `resume-writing:${profile.id}`;
  },
  /** A full listing read; the person and goals lead, as in resumeWriting. */
  listingReading(profile: { id: string }): string {
    return `listing-reading:${profile.id}`;
  },
  /** Fit batches share the person's evidence and goals across searches. */
  fitJudging(profile: { id: string }): string {
    return `fit-judging:${profile.id}`;
  },
  profileCopilot(profile: { id: string }): string {
    return `profile-copilot:${profile.id}`;
  },
  resumeImport(resumeText: string): string {
    return `resume-import:${createHash("sha256")
      .update(resumeText.slice(0, 20_000), "utf8")
      .digest("hex")
      .slice(0, 32)}`;
  },
  jobFit(job: { source: string; sourceJobId: string }): string {
    return `job-fit:${job.source}:${job.sourceJobId}`;
  },
  pageExtraction(pageUrl: string): string {
    try {
      return `discovery:${new URL(pageUrl).hostname.toLowerCase()}`;
    } catch {
      return "discovery:unknown-host";
    }
  },
} as const;
