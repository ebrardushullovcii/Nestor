import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nestor-source-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (name, content) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  git("init", "--quiet");
  git("config", "core.autocrlf", "false");
  write(".gitignore", "/private/\n*.private\n");
  write("packages/example/existing.ts", "export const existing = 1;\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic Helper Test",
    "-c",
    "user.email=helper@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "synthetic baseline",
  );
  const helper = path.join(
    root,
    ".claude/skills/verify-nestor/bin/lib/common.mjs",
  );
  mkdirSync(path.dirname(helper), { recursive: true });
  copyFileSync(new URL("./common.mjs", import.meta.url), helper);
  // The exact helper bytes run in a disposable checkout; no real source or stamp changes.
  const { sourceFingerprint } = await import(pathToFileURL(helper).href);
  return { root, git, write, sourceFingerprint };
}

for (const name of [
  "apps/desktop/src/new.ts",
  "packages/example/new ü source.ts",
]) {
  test(`untracked content changes invalidate the prior identity: ${name}`, async (t) => {
    const { root, git, write, sourceFingerprint } = await fixture(t);
    const clean = sourceFingerprint();
    assert.equal(clean.dirty, null);
    write(name, "export const value = 1;\n");
    const priorBuild = sourceFingerprint();
    const names = git("ls-files", "--others", "--exclude-standard", "-z");
    write(name, "export const value = 2;\n");
    const current = sourceFingerprint();
    assert.equal(
      git("ls-files", "--others", "--exclude-standard", "-z"),
      names,
    );
    assert.equal(current.head, priorBuild.head);
    assert.notEqual(current.dirty, priorBuild.dirty);
    rmSync(path.join(root, name));
    assert.deepEqual(sourceFingerprint(), clean);
  });
}

test("untracked helper, out-of-scope and ignored private files do not affect identity", async (t) => {
  const { write, sourceFingerprint } = await fixture(t);
  const clean = sourceFingerprint();
  write(".claude/another-helper.mjs", "// synthetic helper\n");
  write(
    "apps/desktop/test-fixtures/outside-untracked-scope.txt",
    "synthetic\n",
  );
  write("private/state.json", "{}\n");
  write("packages/example/state.private", "synthetic\n");
  assert.deepEqual(sourceFingerprint(), clean);
});

test("tracked-only changes preserve the existing diff fingerprint", async (t) => {
  const { git, write, sourceFingerprint } = await fixture(t);
  write("packages/example/existing.ts", "export const existing = 2;\n");
  const diff = git("diff", "HEAD", "--", "apps/desktop", "packages");
  assert.equal(
    sourceFingerprint().dirty,
    createHash("sha256").update(diff).digest("hex").slice(0, 12),
  );
});
