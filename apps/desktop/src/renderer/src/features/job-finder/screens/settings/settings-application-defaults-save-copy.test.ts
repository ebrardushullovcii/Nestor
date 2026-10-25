import { describe, expect, it } from "vitest";
import { describeApplicationDefaultsSave } from "./settings-application-defaults-save-copy";

describe("describeApplicationDefaultsSave", () => {
  it("names the apply mode that was saved, not a resume level", () => {
    // Picking Send for me used to toast "Newly shortlisted jobs will start
    // with a tailored resume", even for a person whose resume level was
    // Original.
    const copy = describeApplicationDefaultsSave({
      applicationAutomationMode: "autonomous_submit",
      maxApplicationsPerLocalDay: 20,
    });

    expect(copy.label).toBe("Applying");
    expect(copy.savedMessage).toBe(
      "Applying saved. Apply fills in and sends each application, and pauses only when it needs you. At most 20 a day.",
    );
    expect(copy.savedMessage).not.toContain("resume");
    expect(copy.failedFallback).not.toContain("Resume");
  });

  it("says the resume look was saved for a template or font change", () => {
    const copy = describeApplicationDefaultsSave({
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
    });

    expect(copy.savedMessage).toBe(
      "Resume look saved.",
    );
    expect(copy.label).toBe("Resume look");
  });

  it("keeps the resume-level sentences for a resume-level save", () => {
    expect(
      describeApplicationDefaultsSave({
        resumeApplicationMode: "original_resume",
      }).savedMessage,
    ).toBe(
      "Settings saved. Newly shortlisted jobs will start with your original resume unchanged.",
    );
  });
});
