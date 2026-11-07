import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { chromium, type Page } from "playwright";
import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import { expect, test, vi } from "vitest";
import {
  APPLY_CONTROL_SELECTOR,
  CandidateProfileSchema,
  type BrowserPasswordFill,
} from "@nestor/contracts";
import { createBrowserPasswordRepository } from "@nestor/db";
import {
  createApplyPageHands,
  runApplyAgent,
  type ApplyAgentConfig,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime";
import { PasswordVault } from "./password-vault";
import { BrowserPasswords } from "./browser-passwords";
vi.mock("electron", () => ({ app: {}, safeStorage: {} }));

test("a new-account replica accepts the vault-generated password and later signs in, without putting it in model transcripts or evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-account-replica-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  let server: ChildProcess | undefined;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const file = join(dir, "vault.sqlite");
  const repository = createBrowserPasswordRepository(file);
  const key = randomBytes(32);
  const vault = new PasswordVault(repository, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  });
  try {
    server = spawn(
      process.execPath,
      [resolve("apps/desktop/test-fixtures/job-sites/serve.mjs")],
      {
        windowsHide: true,
        env: {
          ...process.env,
          PORT: "0",
          NESTOR_FIXTURE_SUBMISSIONS_LOG: join(dir, "posts.log"),
        },
      },
    );
    const base = await new Promise<string>((resolve, reject) => {
      server!.stderr!.on("data", (chunk: Buffer) => {
        const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
        if (url) resolve(url);
      });
      server!.once("error", reject);
    });
    const id = randomUUID(),
      username = "synthetic@example.test";
    await page.goto(`${base}/verification-replica/register/${id}`);
    const listeners = new Map<
      string,
      (event: IpcMainEvent, value: unknown) => void
    >();
    // Only this private transport sees the password. The model gets the actual
    // production vault tool and metadata-only results through ApplyPageHands.
    const frame = {
      get url() {
        return page.url();
      },
      send: (_channel: string, value: BrowserPasswordFill) => {
        void page
          .evaluate(
            ({ value, selector }) => {
              const input =
                document.querySelectorAll(selector)[value.target!.controlIndex];
              if (
                !(input instanceof HTMLInputElement) ||
                input.type !== "password" ||
                input.id !== value.target!.id ||
                input.name !== value.target!.name ||
                location.origin !== value.origin
              )
                return false;
              Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
              )!.set!.call(input, value.password);
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            },
            { value, selector: APPLY_CONTROL_SELECTOR },
          )
          .then((ok) =>
            listeners.get("browser-password:filled")?.(
              { senderFrame: frame } as unknown as IpcMainEvent,
              { requestId: value.requestId, ok },
            ),
          );
      },
    };
    const contents = {
      getURL: () => page.url(),
      isDestroyed: () => page.isClosed(),
      mainFrame: { framesInSubtree: [frame] },
    };
    const passwords = new BrowserPasswords(
      {
        pages: () => [
          { id: "tab", contents: contents as unknown as WebContents },
        ],
        changed: () => {},
      },
      () => vault,
      () => true,
    );
    passwords.attach({
      on: (
        name: string,
        handler: (event: IpcMainEvent, value: unknown) => void,
      ) => listeners.set(name, handler),
    } as unknown as IpcMain);
    const mechanics = createPlaywrightApplyPageMechanics(page);
    const target = (
      raw: Awaited<ReturnType<typeof mechanics.readPage>>,
      ref: string,
    ) => {
      const c = raw.controls.find((c) => c.ref === ref)!;
      return {
        controlIndex: c.index,
        id: c.id,
        name: c.name,
        ...(c.frame ? { frame: c.frame } : {}),
      };
    };
    const hands = createApplyPageHands({
      ...mechanics,
      generateAccountCredential: async ({ username, passwordRefs }) => {
        const raw = await mechanics.readPage();
        return passwords.generateAccountCredential(
          "tab",
          username,
          passwordRefs.map((ref) => target(raw, ref)),
        );
      },
      listSavedCredentials: () => Promise.resolve(passwords.list("tab")),
      fillSavedCredential: async (ref, credentialId) =>
        passwords.autofill(
          "tab",
          credentialId,
          true,
          target(await mechanics.readPage(), ref),
        ),
    });
    const config: ApplyAgentConfig = {
      hands,
      authority: {
        mode: "prepare_only",
        submitAuthorized: false,
        allowedOrigins: [],
        preApprovedAttestationKinds: ["terms_acceptance"],
        salaryDisclosure: "answer_from_profile",
      },
      application: {
        jobId: "job",
        applicationId: "account",
        startingUrl: page.url(),
      },
      siteLabel: "Local account replica",
      browserPermissions: {
        signIn: true,
        createAccounts: true,
        googleSignIn: true,
        solveCaptchas: true,
      },
      sources: {
        profile: CandidateProfileSchema.parse({
          id: "synthetic",
          fullName: "Alex Synthetic",
          yearsExperience: 3,
          baseResume: {
            id: "resume",
            fileName: "synthetic.txt",
            uploadedAt: "2026-11-07T00:00:00Z",
            textUpdatedAt: "2026-11-07T00:00:00Z",
            textContent: "Synthetic local resume.",
            extractionStatus: "ready",
          },
        }),
        resumeText: null,
        documents: [],
        reusableAnswers: [],
        posting: {
          title: "Engineer",
          company: "Synthetic",
          location: "Remote",
          description: "Local account replica",
        },
      },
    };
    const transcript: unknown[] = [];
    const run = async (registration: boolean) => {
      let turn = 0;
      return runApplyAgent(config, {
        chatWithTools: async (messages) => {
          transcript.push(messages);
          const raw = await hands.observe();
          const ref = (label: string) =>
            raw.controls.find((c) => c.label === label)!.ref;
          const action = (label: string) =>
            raw.actions.find((a) => a.label === label)!.ref;
          turn++;
          let name: string, args: Record<string, unknown>;
          if (turn === 1) {
            name = "type";
            args = { ref: ref("Email"), text: username };
          } else if (turn === 2 && registration) {
            name = "generate_account_login";
            args = {
              username,
              passwordRefs: [ref("Password"), ref("Confirm password")],
            };
          } else if (turn === 2) {
            name = "list_saved_logins";
            args = {};
          } else if (turn === 3 && !registration) {
            name = "fill_saved_login";
            args = { ref: ref("Password"), credentialId: vault.list()[0]!.id };
          } else if (turn === (registration ? 3 : 4)) {
            name = "click";
            args = { ref: action(registration ? "Create Account" : "Sign in") };
          } else {
            name = "finish";
            args = {
              reason: registration
                ? "The replica account was created."
                : "The replica confirms sign-in.",
            };
          }
          const response = {
            toolCalls: [
              {
                id: `${registration}-${turn}`,
                type: "function" as const,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          };
          transcript.push(response);
          return response;
        },
      });
    };
    await run(true);
    expect(
      await page
        .getByRole("heading", { name: "Your account was created" })
        .count(),
    ).toBe(1);
    expect(vault.list()).toHaveLength(1);
    const secret = vault.read(vault.list()[0]!.id)!.password;
    expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
    await page.goto(`${base}/verification-replica/logout/${id}`);
    await page.goto(`${base}/verification-replica/login/${id}`);
    await run(false);
    expect(
      await page.getByRole("heading", { name: "You are signed in" }).count(),
    ).toBe(1);
    expect(JSON.stringify(transcript).includes(secret)).toBe(false);
    for (const file of readdirSync(dir).filter((f) => /\.jsonl$/u.test(f)))
      expect(readFileSync(join(dir, file), "utf8").includes(secret)).toBe(
        false,
      );
    expect(await readCodeFields(page)).toBe(0);
  } finally {
    await context.close();
    await browser.close();
    server?.kill();
    repository.close();
    vi.unstubAllEnvs();
  }
}, 60_000);

async function readCodeFields(page: Page) {
  return page.locator('input[type="password"]').count();
}
