import { expect, test, vi } from "vitest";
import {
  createJobFinderAiClientFromEnvironment,
  buildResumeRewriteProposalPrompt,
} from "./openai-compatible";
import {
  createEnvironment,
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
} from "./test-fixtures";

test("Aggressive Muse writing and claim checks use Responses at their task efforts", async () => {
  const requests: Array<{
    url: string;
    body: {
      model: string;
      reasoning?: { effort: string };
      input?: unknown[];
      messages?: unknown;
      tools?: Array<{ name?: string }>;
    };
  }> = [];
  let writerTurns = 0;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((url, init) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as (typeof requests)[number]["body"];
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requests.push({ url: requestUrl, body });
      const names = body.tools?.length
        ? (++writerTurns, ["compose_resume_proposal"])
        : [];
      const output = names.length
        ? names.map((name) => ({
            type: "function_call",
            call_id: `call_${writerTurns}_${name}`,
            name,
            arguments:
              name === "compose_resume_proposal"
                ? JSON.stringify({
                    proposal: {
                      summary: {
                        text: "Maintained a synthetic migration ledger.",
                        evidenceRefs: ["baseResume:text"],
                      },
                    },
                  })
                : "{}",
          }))
        : [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    checks: [
                      {
                        id: "line_1",
                        verdict: "supported",
                        reason: "Matches the synthetic evidence",
                        evidenceIds: ["1"],
                      },
                    ],
                  }),
                },
              ],
            },
          ];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "synthetic_response",
            status: "completed",
            output,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });
  try {
    const client = createJobFinderAiClientFromEnvironment(
      createEnvironment({
        NESTOR_AI_MODEL: "separate-primary",
        NESTOR_AI_API_MODE: "chat_completions",
        NESTOR_AI_AGGRESSIVE_MODEL: "muse-spark-1.3-contributor",
        NESTOR_AI_AGGRESSIVE_API_MODE: "responses",
        NESTOR_AI_AGGRESSIVE_REASONING_EFFORT: "xhigh",
      }),
    );
    const profile = createProfile();
    const resumeText = "Maintained a synthetic migration ledger.";
    profile.baseResume.textContent = resumeText;
    const draft = await client.createResumeDraft({
      profile,
      job: createJobPosting(),
      settings: createSettings(),
      searchPreferences: {
        ...createPreferences(),
        tailoringMode: "aggressive",
      },
      resumeText,
    });
    expect(draft.summary).toBe(resumeText);
    expect(draft.generationProvenance?.method).toBe("ai");
    expect(writerTurns).toBe(1);
    const checks = await client.checkResumeClaims?.({
      tailoringStrength: "aggressive",
      job: {
        title: "Synthetic engineer",
        company: "Synthetic employer",
        description: "Maintains a synthetic migration ledger.",
      },
      evidence: [{ id: "baseResume:text", text: resumeText }],
      resumeText,
      claims: [{ id: "line_1", section: "Summary", text: resumeText }],
    });
    expect(checks?.[0]?.verdict).toBe("supported");
    expect(checks?.[0]?.evidenceIds).toEqual(["baseResume:text"]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe("https://example.com/v1/responses");
      expect(request.body.model).toBe("muse-spark-1.3-contributor");
      expect(request.body.input).toBeDefined();
      expect(request.body.messages).toBeUndefined();
    }
    expect(requests.map((request) => request.body.reasoning?.effort)).toEqual([
      "xhigh",
      "xhigh",
    ]);
  } finally {
    fetchMock.mockRestore();
  }
});

test.each(["conservative", "balanced", "aggressive"] as const)(
  "%s writer gets the same prose and relevant-project instructions",
  (mode) => {
    const prompt = buildResumeRewriteProposalPrompt(mode);
    expect(prompt).toContain("merging imported sentence fragments");
    expect(prompt).toContain("use resumeHeadline as the title in the summary");
    expect(prompt).toContain(
      "a Staff posting does not make a Senior candidate Staff",
    );
    expect(prompt).toContain("without manufacturing a generic duty bullet");
    expect(prompt).toContain("without cover-letter promises");
    expect(prompt).toContain(
      "Keep the person's most relevant projects visible",
    );
    expect(prompt).not.toContain("what you would do for this team");
    if (mode === "aggressive")
      expect(prompt).toContain("you may name an adjacent technology");
  },
);
