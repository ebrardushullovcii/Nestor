import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createGeneratedResumeCleanup } from "./generated-resume-cleanup";

test("prunes obsolete exports and HTML while retaining current, application and in-flight files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resume-retention-"));
  const directory = path.join(root, "documents/resumes/generated");
  const junction = path.join(directory, "linked");
  try {
    await mkdir(path.join(directory, "pending"), { recursive: true });
    await mkdir(path.join(directory, "old"));
    for (const file of [
      "current.pdf",
      "application.pdf",
      "obsolete.pdf",
      "obsolete.html",
      "current.html",
      "letter-cover-letter.pdf",
      "pending/resume.pdf",
      "old/resume.pdf",
    ])
      await writeFile(path.join(directory, file), file);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "resume.pdf"), "do not delete");
    await symlink(
      outside,
      junction,
      process.platform === "win32" ? "junction" : "dir",
    );
    let retained = [
      "C:/old/documents/resumes/generated/current.pdf",
      path.join(directory, "application.pdf"),
    ];
    const cleanup = createGeneratedResumeCleanup({
      directory,
      retainedPaths: () => Promise.resolve(retained),
    });
    cleanup.rendering(path.join(directory, "pending"));
    await cleanup.prune();
    expect((await readdir(directory)).sort()).toEqual([
      "application.pdf",
      "current.pdf",
      "letter-cover-letter.pdf",
      "linked",
      "pending",
    ]);
    expect(await readFile(path.join(outside, "resume.pdf"), "utf8")).toBe(
      "do not delete",
    );
    expect(
      await readFile(path.join(directory, "pending/resume.pdf"), "utf8"),
    ).toBe("pending/resume.pdf");
    // Once persisted, the reservation is released and a later replacement can remove it.
    retained = [...retained, path.join(directory, "pending/resume.pdf")];
    await cleanup.prune();
    retained = retained.slice(0, -1);
    await cleanup.prune();
    expect(await readdir(directory)).not.toContain("pending");
    // Remove the junction alone before deleting the owned temporary tree.
    await rm(junction, { recursive: false, force: true });
  } finally {
    await rm(junction, { recursive: false, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes cleanup and reads references when each pass actually runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "resume-retention-order-"));
  try {
    await writeFile(path.join(root, "resume.pdf"), "current");
    let resolveFirst!: (paths: readonly string[]) => void;
    let calls = 0;
    const cleanup = createGeneratedResumeCleanup({
      directory: root,
      retainedPaths: () => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve([path.join(root, "resume.pdf")]);
      },
    });
    cleanup.rendering(root);
    const first = cleanup.prune();
    const second = cleanup.prune();
    await Promise.resolve();
    expect(calls).toBe(1);
    resolveFirst([path.join(root, "resume.pdf")]);
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(await readFile(path.join(root, "resume.pdf"), "utf8")).toBe(
      "current",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discards measured files only from a render reservation inside the managed folder", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "resume-measurement-cleanup-"),
  );
  try {
    const directory = path.join(root, "generated");
    const pending = path.join(directory, "measured");
    await mkdir(pending, { recursive: true });
    const measured = path.join(pending, "resume.pdf");
    const current = path.join(directory, "current.pdf");
    const outside = path.join(root, "download.pdf");
    for (const file of [measured, current, outside])
      await writeFile(file, "resume");
    const cleanup = createGeneratedResumeCleanup({
      directory,
      retainedPaths: () => Promise.resolve([current]),
    });
    cleanup.rendering(pending);
    cleanup.renderingFile(outside);
    await cleanup.discard(current);
    await cleanup.discard(outside);
    await cleanup.discard(measured);
    expect(await readdir(directory)).toEqual(["current.pdf"]);
    expect(await readFile(outside, "utf8")).toBe("resume");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
