import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFreshStartCandidateProfile } from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
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
      "Attachment changed",
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
