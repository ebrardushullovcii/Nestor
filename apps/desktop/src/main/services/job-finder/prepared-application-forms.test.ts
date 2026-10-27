import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFreshStartCandidateProfile } from "@nestor/contracts";
import { openJobStore, createResumeStore } from "@nestor/db/job-store";
import { approvedJobResumeIdentity } from "@nestor/job-finder/applications";
import { createPreparedApplicationFormStore } from "./prepared-application-forms";

test("a restored form attaches the resume only while its bytes are unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestor-form-file-"));
  const store = openJobStore(":memory:");
  try {
    const bytes = Buffer.from("synthetic file");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filePath = join(directory, "synthetic.txt");
    await writeFile(filePath, bytes);
    const profile = createFreshStartCandidateProfile();
    profile.baseResume = {
      ...profile.baseResume,
      id: "source",
      storagePath: filePath,
      sha256,
    };
    const assets = { resolveForApplication: vi.fn() };
    const forms = createPreparedApplicationFormStore(
      store,
      { getProfile: () => Promise.resolve(profile) },
      assets,
    );
    const identity = {
      kind: "resume_source" as const,
      id: "source",
      name: "synthetic.txt",
      sha256,
    };
    expect(await forms.loadAttachment(identity)).toEqual(bytes);
    await writeFile(filePath, Buffer.alloc(bytes.length, 1));
    await expect(forms.loadAttachment(identity)).rejects.toThrow(
      "Original resume changed",
    );
    await expect(
      forms.loadAttachment({ ...identity, id: "other" }),
    ).rejects.toThrow("Resume unavailable");
    await expect(
      forms.loadAttachment({ ...identity, kind: "resume_export" }),
    ).rejects.toThrow("Resume unavailable");
    expect(assets.resolveForApplication).not.toHaveBeenCalled();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tailored attachment resolves only its current approved job-resume identity and bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestor-tailored-file-"));
  const store = openJobStore(":memory:");
  try {
    const bytes = Buffer.from("synthetic tailored PDF"),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const filePath = join(directory, "tailored.pdf");
    await writeFile(filePath, bytes);
    const [id] = store.saveFoundJobs({
      searchId: null,
      jobs: [
        {
          title: "Engineer",
          company: "Synthetic",
          location: "Remote",
          workModes: ["remote"],
          url: "https://synthetic.test/jobs/1",
          applyUrl: null,
          sourceId: "synthetic",
          sourceLabel: "Synthetic",
          sourceJobId: "1",
          postedAt: null,
          salaryText: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          seniority: null,
          employmentType: null,
          summary: null,
          description: "Synthetic",
        },
      ],
    }).added;
    store.setStage([id!], "shortlisted");
    const resumes = createResumeStore(store);
    resumes.startWriting(id!, "tailored");
    resumes.finishWriting(id!, null);
    resumes.approve(id!, filePath, sha256);
    const forms = createPreparedApplicationFormStore(
      store,
      { getProfile: () => Promise.resolve(createFreshStartCandidateProfile()) },
      { resolveForApplication: vi.fn() },
    );
    const attachment = {
      kind: "resume_export" as const,
      id: approvedJobResumeIdentity(resumes.get(id!)!),
      name: "tailored.pdf",
      sha256,
    };
    expect(await forms.loadAttachment(attachment)).toEqual(bytes);
    await expect(
      forms.loadAttachment({
        ...attachment,
        id: attachment.id.replace(sha256, "0".repeat(64)),
      }),
    ).rejects.toThrow("Approved resume changed");
    await writeFile(filePath, "changed PDF");
    await expect(forms.loadAttachment(attachment)).rejects.toThrow(
      "Attachment changed",
    );
    resumes.setLevel(id!, "light");
    await expect(forms.loadAttachment(attachment)).rejects.toThrow(
      "Approved resume unavailable",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
