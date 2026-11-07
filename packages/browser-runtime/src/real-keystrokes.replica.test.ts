import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createApplyPageHands,
  runApplyAgent,
  type ApplyAgentConfig,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";

let browser: Browser;
let server: Server;
let origin: string;
let accepted = 0;
let searches: string[] = [];

// A fictional applicant lives in Prishtina. No owner profile or browser data is used.
const form = `<!doctype html><title>Location replica</title>
<form action="/send" method="post">
  <label>Current location<input id="location" name="location" required autocomplete="off"></label>
  <input type="hidden" id="selected" name="selected">
  <div id="status">No location found. Try entering a different location</div>
  <div id="suggestions"></div><button>Send application</button>
</form><script>
const field=document.querySelector('#location'), list=document.querySelector('#suggestions'), status=document.querySelector('#status');
let highlighted=false;
window.keyEvents=[];
field.addEventListener('keydown',e=>{
  keyEvents.push({type:e.type,key:e.key,trusted:e.isTrusted});
  if(e.key==='ArrowDown' && list.firstElementChild){highlighted=true;list.firstElementChild.setAttribute('aria-selected','true');e.preventDefault()}
  if(e.key==='Enter' && highlighted){choose();e.preventDefault()}
  if(e.key==='Escape'){list.replaceChildren();highlighted=false}
});
field.addEventListener('keypress',e=>keyEvents.push({type:e.type,key:e.key,trusted:e.isTrusted}));
field.addEventListener('keyup',async e=>{
  keyEvents.push({type:e.type,key:e.key,trusted:e.isTrusted});
  if(e.key.length!==1 && e.key!=='Backspace')return;
  const query=field.value;status.textContent='Loading';
  const response=await fetch('/locations?q='+encodeURIComponent(query));
  const names=await response.json();if(field.value!==query)return;
  list.replaceChildren();highlighted=false;
  status.textContent=names.length?'Choose your location':'No location found. Try entering a different location';
  for(const name of names){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=name;option.onclick=choose;list.append(option)}
});
function choose(){field.value='Prishtina, Kosovo';document.querySelector('#selected').value=field.value;list.replaceChildren();status.textContent='Location selected';highlighted=false}
</script>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/locations?")) {
      const query = new URL(req.url, "http://replica.test").searchParams.get(
        "q",
      )!;
      searches.push(query);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          "prishtina, kosovo".startsWith(query.toLowerCase())
            ? ["Prishtina, Kosovo"]
            : [],
        ),
      );
    } else if (req.url === "/send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const values = new URLSearchParams(body);
        if (
          values.get("location") === "Prishtina, Kosovo" &&
          values.get("selected") === "Prishtina, Kosovo"
        ) {
          accepted++;
          res.end("<h1>Application received</h1>");
        } else {
          res.statusCode = 422;
          res.end("Choose a location suggestion");
        }
      });
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(form);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing replica address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("replacement typing does not trigger a keyup-driven location search", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<label>Current location<input id="location"></label>
      <div id="status">No location found. Try entering a different location</div>
      <script>locationSearches=0;document.querySelector('input').onkeyup=()=>{locationSearches++;document.querySelector('#status').textContent='Prishtina, Kosovo'}</script>`);
    const raw = createPlaywrightApplyPageMechanics(page);
    const ref = (await raw.readPage()).controls[0]!.ref!;
    expect(await raw.fillText(ref, "Prishtina")).toMatchObject({ ok: true });
    expect(
      await page.evaluate(
        () => Reflect.get(window, "locationSearches") as unknown,
      ),
    ).toBe(0);
    expect(await page.locator("#status").textContent()).toContain(
      "No location found",
    );
  } finally {
    await page.close();
  }
});

test.each([
  ["an autocomplete without an option list", ""],
  [
    "an autocomplete under a challenge overlay",
    '<div style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>',
  ],
])(
  "select on %s returns its observed facts",
  async (_name, overlay) => {
    const page = await browser.newPage();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await page.setContent(
        `<label>Current location<input id="location"></label><div>No location found. Try entering a different location</div>${overlay}`,
      );
      const raw = createPlaywrightApplyPageMechanics(page);
      const ref = (await raw.readPage()).controls[0]!.ref!;
      const result = await Promise.race([
        raw.chooseOption(ref, "Prishtina, Kosovo"),
        new Promise<"stalled">((resolve) => {
          timer = setTimeout(() => resolve("stalled"), 8_000);
        }),
      ]);
      expect(result).not.toBe("stalled");
      expect(result).toMatchObject({
        ok: false,
        optionList: { open: false, complete: false, options: [] },
      });
    } finally {
      clearTimeout(timer);
      await page.close();
    }
  },
  12_000,
);

test.each([
  "prepare_only",
  "confirm_before_submit",
  "autonomous_submit",
] as const)(
  "%s exposes keyboard tools and chooses the returned real location; only Send accepts an application",
  async (mode) => {
    const page = await browser.newPage();
    accepted = 0;
    searches = [];
    try {
      await page.goto(origin);
      const raw = createPlaywrightApplyPageMechanics(page);
      const hands = createApplyPageHands(raw);
      const config: ApplyAgentConfig = {
        hands,
        authority: {
          mode,
          submitAuthorized: mode === "autonomous_submit",
          preApprovedAttestationKinds: [],
          salaryDisclosure: "answer_from_profile",
          allowedOrigins: [],
        },
        sources: {
          profile: CandidateProfileSchema.parse({
            id: "replica",
            firstName: "Test",
            lastName: "Applicant",
            fullName: "Test Applicant",
            email: "synthetic@example.test",
            currentLocation: "Prishtina, Kosovo",
            yearsExperience: 3,
            baseResume: {
              id: "replica",
              fileName: "replica.txt",
              uploadedAt: "2026-11-01T00:00:00.000Z",
              textContent: "Synthetic applicant",
              extractionStatus: "ready",
            },
          }),
          resumeText: null,
          posting: {
            title: "Engineer",
            company: "Replica",
            location: "Remote",
            description: "Replica role",
          },
          reusableAnswers: [],
          documents: [],
        },
        application: {
          jobId: "replica",
          applicationId: "replica",
          startingUrl: origin,
        },
        siteLabel: "Replica",
        intermediateWritesAuthorized: true,
        submitApplication: async ({ actionRef }) => {
          await raw.clickElement(actionRef);
          return { outcome: "submitted", content: "Application received" };
        },
      };
      let turn = 0;
      let sawSuggestion = false;
      let sawSelection = false;
      await runApplyAgent(config, {
        chatWithTools: async (messages, tools) => {
          expect(tools.map((tool) => tool.function.name)).toEqual(
            expect.arrayContaining(["type_keys", "press_key"]),
          );
          expect(String(messages[0]?.content)).toContain(
            "Probe fields only with the person's real values",
          );
          const seen = await hands.observe();
          const field = seen.controls.find(
            (c) => c.label === "Current location",
          );
          const call = (name: string, args: object) => ({
            content: "",
            toolCalls: [
              {
                id: `keyboard-${mode}-${turn}`,
                type: "function" as const,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
          switch (turn++) {
            case 0:
              return call("type_keys", { ref: field!.ref, text: "Prishtina" });
            case 1:
              await page
                .getByRole("option", { name: "Prishtina, Kosovo" })
                .waitFor();
              return call("observe", {});
            case 2:
              sawSuggestion = String(
                messages.filter((m) => m.role === "tool").at(-1)?.content,
              ).includes("Prishtina, Kosovo");
              return call("press_key", { ref: field!.ref, key: "ArrowDown" });
            case 3:
              return call("press_key", { key: "Enter" });
            case 4:
              sawSelection =
                field!.value === "Prishtina, Kosovo" &&
                seen.bodyTextExcerpt.includes("Location selected");
              expect(await page.locator("#selected").inputValue()).toBe(
                "Prishtina, Kosovo",
              );
              expect(searches).toContain("Prishtina");
              expect(
                await page.evaluate(
                  () => Reflect.get(window, "keyEvents") as unknown,
                ),
              ).toEqual(
                expect.arrayContaining([
                  { type: "keydown", key: "P", trusted: true },
                  { type: "keypress", key: "P", trusted: true },
                  { type: "keyup", key: "P", trusted: true },
                  { type: "keydown", key: "ArrowDown", trusted: true },
                  { type: "keyup", key: "Enter", trusted: true },
                ]),
              );
              return mode === "autonomous_submit"
                ? call("submit_application", {
                    ref: seen.actions.find(
                      (a) => a.label === "Send application",
                    )!.ref,
                  })
                : call("finish", {
                    reason: "Location selected; ready for the person",
                  });
            default:
              return call("finish", { reason: "Application received" });
          }
        },
      });
      expect(sawSuggestion).toBe(true);
      expect(sawSelection).toBe(true);
      expect(accepted).toBe(mode === "autonomous_submit" ? 1 : 0);
    } finally {
      await page.close();
    }
  },
  20_000,
);

test("named keys edit the caret, dismiss suggestions and tab, and stale keyboard refs do not wait", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const raw = createPlaywrightApplyPageMechanics(page);
    const ref = (await raw.readPage()).controls.find(
      (c) => c.id === "location",
    )!.ref!;
    await raw.typeKeys!(ref, "Prishtina");
    await page.getByRole("option").waitFor();
    await raw.pressKey(ref, "Escape");
    expect(await page.getByRole("option").count()).toBe(0);
    await raw.pressKey(ref, "ControlOrMeta+A");
    await raw.pressKey(undefined, "Backspace");
    await raw.typeKeys!(ref, "Prishtina");
    expect(await page.locator("#location").inputValue()).toBe("Prishtina");
    await raw.pressKey(undefined, "Tab");
    expect(
      await page
        .locator("button")
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page
      .locator("#location")
      .evaluate((node) => node.replaceWith(node.cloneNode(true)));
    for (const result of [
      await raw.typeKeys!(ref, "Prishtina"),
      await raw.pressKey(ref, "ArrowDown"),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatch(/stale|missing|observe again/i);
    }
  } finally {
    await page.close();
  }
}, 10_000);
