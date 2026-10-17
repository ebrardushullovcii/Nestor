import {
  CoverLetterPreferenceSchema,
  JobFinderSettingsSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  ApplicationLetterGroundingError,
  createApplicationLetterProvider,
} from "./application-letter-provider";

/**
 * One application, one letter.
 *
 * The thing that must never happen is a person discovering they sent one
 * letter as an attachment and different words in the box on the same form.
 */

const PREFERENCE = {
  tone: "plain_professional" as const,
  length: "standard" as const,
  language: null,
  sample: null,
};

const REQUEST = {
  prompt: "Write a cover letter.",
  groundedIn: ["your profile"],
  language: null,
};

function provider(
  overrides: {
    writeLetter?: (input: {
      prompt: string;
      priorText: string | null;
    }) => Promise<string | null>;
    renderLetter?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const writeLetter =
    overrides.writeLetter ??
    (() => Promise.resolve("Dear hiring team, I build platforms."));
  return createApplicationLetterProvider({
    preference: PREFERENCE,
    application: { jobId: "job_test", applicationId: "application_test" },
    writeLetter,
    ...(overrides.renderLetter ? { renderLetter: overrides.renderLetter } : {}),
  });
}

describe("the letter provider", () => {
  test("writes once and hands the same words back for the box and the file", async () => {
    const writeLetter = vi.fn(() =>
      Promise.resolve("Dear hiring team, I build platforms."),
    );
    const renderLetter = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        fileName: "letter.pdf",
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
      }),
    );
    const letters = provider({ writeLetter, renderLetter });

    const typed = await letters.provide({
      ...REQUEST,
      delivery: "text",
      fileType: null,
    });
    const attached = await letters.provide({
      ...REQUEST,
      delivery: "file",
      fileType: "pdf",
    });

    expect(writeLetter).toHaveBeenCalledTimes(1);
    expect(typed.ok && attached.ok).toBe(true);
    if (typed.ok && attached.ok) {
      expect(typed.text).toBe(attached.text);
      expect(attached.document?.fileName).toBe("letter.pdf");
      expect(typed.document).toBeNull();
    }
  });

  test("renders a given file type once and reuses the exact file", async () => {
    const renderLetter = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        fileName: "letter.pdf",
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
      }),
    );
    const letters = provider({ renderLetter });

    const first = await letters.provide({
      ...REQUEST,
      delivery: "file",
      fileType: "pdf",
    });
    const second = await letters.provide({
      ...REQUEST,
      delivery: "file",
      fileType: "pdf",
    });

    expect(renderLetter).toHaveBeenCalledTimes(1);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.document?.id).toBe(second.document?.id);
    }
  });

  test("keeps different purposes and revised instructions as distinct stable versions", async () => {
    const writeLetter = vi.fn(({ prompt }: { prompt: string }) =>
      Promise.resolve(`Written from: ${prompt}`),
    );
    const renderLetter = vi.fn(({ text }: { text: string }) =>
      Promise.resolve({
        ok: true as const,
        fileName: `${text.length}.pdf`,
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(new TextEncoder().encode(text)),
      }),
    );
    const letters = provider({ writeLetter, renderLetter });

    const cover = await letters.provide({
      ...REQUEST,
      purpose: "cover_letter",
      delivery: "file",
      fileType: "pdf",
    });
    const motivation = await letters.provide({
      ...REQUEST,
      purpose: "motivation_letter",
      prompt: "Explain why this mission matters.",
      delivery: "file",
      fileType: "pdf",
    });
    const revised = await letters.provide({
      ...REQUEST,
      purpose: "cover_letter",
      prompt: "Revise the cover letter to be shorter.",
      delivery: "file",
      fileType: "pdf",
    });
    const repeatedRevision = await letters.provide({
      ...REQUEST,
      purpose: "cover_letter",
      prompt: "Revise the cover letter to be shorter.",
      delivery: "file",
      fileType: "pdf",
    });

    expect(writeLetter).toHaveBeenCalledTimes(3);
    expect(renderLetter).toHaveBeenCalledTimes(3);
    if (cover.ok && motivation.ok && revised.ok && repeatedRevision.ok) {
      expect(
        new Set([
          cover.document?.id,
          motivation.document?.id,
          revised.document?.id,
        ]).size,
      ).toBe(3);
      expect(revised.document?.id).toBe(repeatedRevision.document?.id);
      expect(revised.text).toBe(repeatedRevision.text);
      expect(cover.text).not.toBe(motivation.text);
      expect(cover.text).not.toBe(revised.text);
    }
    expect(writeLetter).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        purpose: "cover_letter",
        groundedIn: ["your profile"],
        priorText: "Written from: Write a cover letter.",
      }),
    );
  });

  test("a file type that cannot be produced leaves the file to the person", async () => {
    const renderLetter = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        reason: "This form asks for a Word file.",
      }),
    );
    const letters = provider({ renderLetter });

    const result = await letters.provide({
      ...REQUEST,
      delivery: "file",
      fileType: "docx",
    });

    // The words exist; the file does not, so the caller pauses rather than
    // attaching something that is not what was asked for.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("I build platforms");
      expect(result.document).toBeNull();
    }
  });

  test("no assistant means no letter, said as an outage", async () => {
    const letters = provider({ writeLetter: () => Promise.resolve(null) });

    const result = await letters.provide({
      ...REQUEST,
      delivery: "text",
      fileType: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unavailable right now");
      expect(result.reason).not.toMatch(/api key|settings|configure/iu);
    }
  });
});

describe("the saved letter preference", () => {
  test("defaults to something unremarkable and follows the posting's language", () => {
    const preference = CoverLetterPreferenceSchema.parse({});
    expect(preference).toEqual({
      tone: "plain_professional",
      length: "standard",
      language: null,
      sample: null,
    });
  });

  test("survives a settings round trip beside the resume preferences", () => {
    const settings = JobFinderSettingsSchema.parse({
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
      appearanceTheme: "system",
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: false,
      discoveryOnly: false,
      coverLetter: {
        tone: "direct",
        length: "short",
        language: "German",
        sample: "Ich baue Werkzeuge, auf die sich andere verlassen.",
      },
    });

    expect(settings.coverLetter?.tone).toBe("direct");
    expect(settings.coverLetter?.language).toBe("German");

    // A workspace saved before letters existed still loads, with the defaults.
    const older = JobFinderSettingsSchema.parse({
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
      appearanceTheme: "system",
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: false,
      discoveryOnly: false,
    });
    expect(
      CoverLetterPreferenceSchema.parse(older.coverLetter ?? {}).tone,
    ).toBe("plain_professional");
  });
});

test("an unsupported letter is handed back with its reason and is never rendered", async () => {
  const renderLetter = vi.fn();
  const letterProvider = provider({
    writeLetter: () => {
      return Promise.reject(
        new ApplicationLetterGroundingError(
          "The claimed result is not in your profile or resume.",
          "Draft needing review",
        ),
      );
    },
    renderLetter,
  });
  expect(
    await letterProvider.provide({
      ...REQUEST,
      delivery: "file",
      fileType: "pdf",
    }),
  ).toEqual({
    ok: false,
    reason:
      "The letter needs your review: The claimed result is not in your profile or resume.",
    draftText: "Draft needing review",
  });
  expect(renderLetter).not.toHaveBeenCalled();
});

test("renders the person's approved letter word for word without writing or checking it again", async () => {
  const writeLetter = vi
    .fn()
    .mockRejectedValue(new Error("Must not rewrite approved text"));
  const renderLetter = vi.fn(({ text }: { text: string }) =>
    Promise.resolve({
      ok: true as const,
      fileName: "letter.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new TextEncoder().encode(text)),
    }),
  );
  const letters = provider({ writeLetter, renderLetter });
  const approvedText =
    "I enjoy building dependable platforms.\nI can work 20 hours a week from Manchester.\n";
  const result = await letters.provide({
    ...REQUEST,
    approvedText,
    delivery: "file",
    fileType: "pdf",
  });
  expect(writeLetter).not.toHaveBeenCalled();
  expect(renderLetter).toHaveBeenCalledWith(
    expect.objectContaining({ text: approvedText, fileType: "pdf" }),
  );
  if (!result.ok || !result.document)
    throw new Error("Expected approved letter file");
  expect(new TextDecoder().decode(await result.document.loadBytes())).toBe(
    approvedText,
  );
  // Named as the person's letter, not "v1" of this run.
  expect(result.document.label).toBe("Cover letter you approved");
});
