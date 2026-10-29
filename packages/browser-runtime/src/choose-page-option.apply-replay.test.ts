import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/picker-option-result.json";
import { choosePageOption } from "./choose-page-option";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

const longList = Array.from(
  { length: replay.longListSize },
  (_, index) => `Region ${String(index).padStart(3, "0")}`,
);

/** A list that draws only the rows in view, the way long country lists do. */
const virtualList = (rows: readonly string[]) => `
<label>Country<input role="combobox" readonly aria-controls="virtual-options"></label>
<div id="virtual-options" role="listbox" style="height:200px;overflow-y:auto;position:relative">
  <div id="spacer" style="height:${rows.length * 20}px"></div>
</div>
<script>
  const rows = ${JSON.stringify(rows)};
  const list = document.getElementById("virtual-options");
  const draw = () => {
    list.querySelectorAll("[role=option]").forEach((row) => row.remove());
    const first = Math.floor(list.scrollTop / 20);
    rows.slice(first, first + 12).forEach((text, offset) => {
      const row = document.createElement("div");
      row.setAttribute("role", "option");
      row.textContent = text;
      row.style.cssText = "position:absolute;height:20px;top:" + (first + offset) * 20 + "px";
      row.onclick = () => (document.querySelector("input").value = text);
      list.appendChild(row);
    });
  };
  list.addEventListener("scroll", draw);
  draw();
</script>`;

test("native picker replay returns typed absence and its offered choices without changing selection", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<select aria-label="Country">${replay.offered.map((option) => `<option>${option}</option>`).join("")}</select>`,
    );
    const control = page.getByLabel("Country");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: replay.offered,
      },
    );
    expect(await control.inputValue()).toBe(replay.offered[0]);
  });
});

test("a native list whose choices load after a moment is waited for, not read as missing", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<select aria-label="Country"><option value="">Select…</option></select>
      <script>setTimeout(() => { for (const text of ${JSON.stringify([...replay.offered, replay.missing])}) document.querySelector("select").add(new Option(text, text)); }, 900);</script>`,
    );
    const control = page.getByLabel("Country");
    expect(await choosePageOption(page, control, replay.missing)).toEqual({
      ok: true,
      observedValue: replay.missing,
    });
    expect(await control.inputValue()).toBe(replay.missing);
  });
}, 15_000);

test("native option text with stray spacing still matches the asked-for choice", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<select aria-label="Country"><option value="">Select…</option><option value="a">\n  ${replay.offered[0]}\n</option><option value="b">${replay.offered[1]}</option></select>`,
    );
    const control = page.getByLabel("Country");
    expect(
      await choosePageOption(
        page,
        control,
        ` ${replay.offered[0]!.toUpperCase()} `,
      ),
    ).toEqual({ ok: true, observedValue: replay.offered[0] });
    expect(await control.inputValue()).toBe("a");
  });
});

test("an empty or placeholder-only native list is uncertain, never proof of absence", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<select aria-label="Country"><option value="">-- Choose a country --</option></select>`,
    );
    const result = await choosePageOption(
      page,
      page.getByLabel("Country"),
      replay.missing,
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("offeredOptions");
  });
}, 15_000);

test("a dependent native list that enables later reports only its real choices", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<select aria-label="State" disabled><option value="">Select a state</option></select>
      <script>setTimeout(() => { const s = document.querySelector("select"); for (const text of ${JSON.stringify(replay.offered)}) s.add(new Option(text, text)); s.disabled = false; }, 600);</script>`,
    );
    expect(
      await choosePageOption(page, page.getByLabel("State"), replay.missing),
    ).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: replay.offered,
    });
  });
}, 15_000);

test("custom picker replay reports its own choices, then permits the saved fallback", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<label>Country<input role="combobox" aria-controls="country-options"></label><div id="country-options" role="listbox">${replay.offered.map((option) => `<div role="option" onclick="document.querySelector('input').value=this.textContent">${option}</div>`).join("")}</div><div role="listbox"><div role="option">${replay.unrelated}</div></div>`,
    );
    const control = page.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: replay.offered,
      },
    );
    expect(await control.inputValue()).toBe("");
    expect(await choosePageOption(page, control, replay.offered[0]!)).toEqual({
      ok: true,
      observedValue: replay.offered[0],
    });
    expect(await control.inputValue()).toBe(replay.offered[0]);
  });
}, 20_000);

test("a long list that draws only rows in view is scrolled before a choice is called missing", async () => {
  await withPage(async (page) => {
    await page.setContent(virtualList(longList));
    const control = page.getByRole("combobox");
    const wanted = longList[replay.longListWantedIndex]!;
    expect(await choosePageOption(page, control, wanted)).toEqual({
      ok: true,
      observedValue: wanted,
    });
    expect(await control.inputValue()).toBe(wanted);
  });
  await withPage(async (page) => {
    await page.setContent(virtualList(longList));
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      replay.missing,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "option_not_offered",
    });
    expect(result.ok ? [] : result.offeredOptions).toEqual(longList);
  });
}, 30_000);

test("a list showing only a Loading… row is uncertain", async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<label>Country<input role="combobox" readonly aria-controls="country-options"></label><div id="country-options" role="listbox"><div role="option">Loading…</div></div>',
    );
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      replay.missing,
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("reason");
  });
}, 15_000);

test.each([
  [
    "disabled placeholder",
    '<div role="option" aria-disabled="true">Select a country…</div>',
  ],
  ["enabled placeholder", '<div role="option">Select a country…</div>'],
  [
    "disabled choices",
    '<div role="option" aria-disabled="true">Austria</div><button role="option" disabled>Croatia</button>',
  ],
])(
  "custom lists without usable choices are uncertain: %s",
  async (_name, rows) => {
    await withPage(async (page) => {
      await page.setContent(
        `<label>Country<input role="combobox" readonly aria-controls="country-options"></label><div id="country-options" role="listbox">${rows}</div>`,
      );
      const result = await choosePageOption(
        page,
        page.getByRole("combobox"),
        replay.missing,
      );
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("reason");
      expect(result).not.toHaveProperty("offeredOptions");
    });
  },
  15_000,
);

test("custom handover excludes placeholder and disabled rows from real choices", async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <label>Country<input role="combobox" readonly aria-controls="country-options"></label>
      <div id="country-options" role="listbox">
        <div role="option" aria-disabled="true">Select a country…</div>
        <div role="option">Austria</div>
        <div role="option" aria-disabled="true">Croatia</div>
      </div>`);
    expect(
      await choosePageOption(page, page.getByRole("combobox"), "Croatia"),
    ).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: ["Austria"],
    });
  });
}, 15_000);

/** A search box over a list, like the ones that showed "No results" in the real round. */
const searchPicker = (
  options: readonly string[],
  delayMs: number,
  initialQuery = "",
) => `
<label>Country<input role="combobox" aria-controls="search-options"></label>
<div id="search-options" role="listbox"></div>
<script>
  const options = ${JSON.stringify(options)};
  const input = document.querySelector("input");
  const list = document.getElementById("search-options");
  const draw = (query) => {
    list.replaceChildren();
    const shown = options.filter((text) => text.toLowerCase().includes(query.toLowerCase()));
    for (const text of shown) {
      const row = document.createElement("div");
      row.setAttribute("role", "option");
      row.textContent = text;
      row.onclick = () => { input.value = text; input.dataset.committed = text; };
      list.appendChild(row);
    }
    if (!shown.length) list.textContent = "No results";
  };
  input.addEventListener("input", () => {
    const query = input.value;
    setTimeout(() => draw(query), ${delayMs});
  });
  draw(${JSON.stringify(initialQuery)});
</script>`;

test("a custom handover uses the full list order after a filtered search, including on retry", async () => {
  await withPage(async (page) => {
    const options = ["Austria", "Croatia", "CROATIA", "Cyprus"];
    await page.setContent(searchPicker(options, 0));
    const control = page.getByRole("combobox");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await choosePageOption(page, control, "Cro")).toMatchObject({
        ok: false,
        reason: "option_not_offered",
        offeredOptions: ["Austria", "Croatia", "Cyprus"],
      });
      expect(await control.inputValue()).toBe("");
    }
  });
}, 20_000);

test("a search that finds nothing reports the form's real choices and leaves no typed search behind", async () => {
  await withPage(async (page) => {
    const options = [...replay.offered, replay.variant];
    await page.setContent(searchPicker(options, 0));
    const control = page.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: options,
      },
    );
    expect(await control.inputValue()).toBe("");
  });
}, 20_000);

test("a search that hides every row, with no message, is checked against the full list", async () => {
  // The replica sites' own country picker: rows are hidden, not removed, and
  // a spinner sits in the list undrawn.
  await withPage(async (page) => {
    await page.setContent(`
      <label for="country-search">Country</label>
      <input id="country-search" role="combobox" aria-controls="country-options">
      <ul id="country-options" role="listbox" hidden>
        <li class="spinner" style="display:none"></li>
        ${replay.offered.map((option) => `<li role="option" data-value="${option}">${option}</li>`).join("")}
      </ul>
      <script>
        const input = document.getElementById("country-search");
        const list = document.getElementById("country-options");
        const rows = [...list.querySelectorAll("[role=option]")];
        const filter = () => {
          rows.forEach((row) => (row.hidden = !row.dataset.value.toLowerCase().includes(input.value.toLowerCase())));
          list.hidden = false;
        };
        input.addEventListener("focus", filter);
        input.addEventListener("input", filter);
        rows.forEach((row) => row.addEventListener("click", () => { input.value = row.dataset.value; list.hidden = true; }));
      </script>`);
    const control = page.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: replay.offered,
      },
    );
    expect(await control.inputValue()).toBe("");
    expect(await choosePageOption(page, control, replay.offered[1]!)).toEqual({
      ok: true,
      observedValue: replay.offered[1],
    });
    expect(await control.inputValue()).toBe(replay.offered[1]);
  });
}, 30_000);

test("rows left over from before a search are not read as its answer", async () => {
  await withPage(async (page) => {
    await page.setContent(
      searchPicker([...replay.offered, replay.missing], 1_500, "region"),
    );
    const control = page.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toEqual({
      ok: true,
      observedValue: replay.missing,
    });
    expect(await control.getAttribute("data-committed")).toBe(replay.missing);
  });
}, 20_000);

test("a picker without a bound list still chooses from the page's options", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<button role="combobox" onclick="document.getElementById('menu').hidden=false">Sort</button>
      <div id="menu" hidden><div role="option" onclick="document.body.dataset.chosen=this.textContent">${replay.offered[0]}</div></div>`,
    );
    expect(
      await choosePageOption(
        page,
        page.getByRole("combobox"),
        replay.offered[0]!,
      ),
    ).toEqual({ ok: true, observedValue: replay.offered[0] });
    expect(await page.locator("body").getAttribute("data-chosen")).toBe(
      replay.offered[0],
    );
  });
}, 15_000);

test("an unfinished empty list is uncertain, not proof that an option does not exist", async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<label>Country<input role="combobox" aria-controls="country-options" aria-busy="true"></label><div id="country-options" role="listbox"></div>',
    );
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      replay.missing,
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("offeredOptions");
  });
}, 15_000);

test("a picker in a frame reports only that frame's choices despite matching list ids", async () => {
  await withPage(async (page) => {
    await page.setContent(
      `<div id="country-options" role="listbox"><div role="option" onclick="document.body.dataset.wrongChoice='yes'">${replay.missing}</div></div><iframe></iframe>`,
    );
    const frame = page.frames().find((entry) => entry !== page.mainFrame())!;
    await frame.setContent(
      `<label>Country<input role="combobox" aria-controls="country-options"></label><div id="country-options" role="listbox">${replay.offered.map((option) => `<div role="option" onclick="document.querySelector('input').value=this.textContent">${option}</div>`).join("")}</div>`,
    );
    const control = frame.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: replay.offered,
      },
    );
    expect(
      await page.locator("body").getAttribute("data-wrong-choice"),
    ).toBeNull();
    expect(await choosePageOption(page, control, replay.offered[0]!)).toEqual({
      ok: true,
      observedValue: replay.offered[0],
    });
    expect(await control.inputValue()).toBe(replay.offered[0]);
  });
}, 20_000);

test("settled search rows are offered even when clearing cannot expose the full list", async () => {
  // Typing filters the list; clearing the search closes it, so the full list
  // is never read.
  await withPage(async (page) => {
    const options = [...replay.offered, replay.variant];
    await page.setContent(`
      <label>Country<input role="combobox" aria-controls="search-options"></label>
      <div id="search-options" role="listbox"></div>
      <script>
        const options = ${JSON.stringify(options)};
        const input = document.querySelector("input");
        const list = document.getElementById("search-options");
        input.addEventListener("input", () => {
          list.replaceChildren();
          if (!input.value) return;
          for (const text of options.filter((entry) => entry.toLowerCase().includes(input.value.toLowerCase().slice(0, 3)))) {
            const row = document.createElement("div");
            row.setAttribute("role", "option");
            row.textContent = text;
            list.appendChild(row);
          }
        });
      </script>`);
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      "Fallback territory",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: [replay.offered[0], replay.variant],
    });
  });
}, 30_000);

/** Remote results replace the menu; no unfiltered inventory is exposed. */
const remotePicker = (results: Record<string, string[]>, reject = false) => `
<label>Answer<input role="combobox" aria-controls="remote-options"></label>
<div id="remote-options" role="listbox" hidden></div>
<script>
  const results = ${JSON.stringify(results)};
  const input = document.querySelector("input");
  const list = document.getElementById("remote-options");
  window.queries = [];
  let request = 0;
  input.addEventListener("input", () => {
    const query = input.value;
    window.queries.push(query);
    input.dataset.committed = "";
    list.replaceChildren();
    list.hidden = !query;
    const current = ++request;
    if (!query) return;
    list.setAttribute("aria-busy", "true");
    setTimeout(() => {
      if (current !== request) return;
      list.removeAttribute("aria-busy");
      for (const text of results[query] || []) {
        const row = document.createElement("div");
        row.setAttribute("role", "option");
        row.textContent = text;
        row.onmousedown = (event) => event.preventDefault();
        row.onclick = () => {
          input.value = text;
          input.dataset.committed = ${reject} ? "" : text;
          list.hidden = true;
        };
        list.appendChild(row);
      }
      if (!list.children.length) list.textContent = "No results";
    }, 150);
  });
  input.addEventListener("blur", () => { input.value = input.dataset.committed || ""; });
</script>`;

test.each([
  {
    name: "a spelling variant from the full query",
    value: "Prishtina",
    results: { Prishtina: ["Pristina", "Prizren"], Pristina: ["Pristina"] },
    offered: ["Pristina", "Prizren"],
    queries: ["Prishtina"],
  },
  {
    name: "leading words then a leading word",
    value: "Bachelor Computer Science",
    results: {
      "Bachelor Computer": ["Bachelor of Computer Science"],
      Bachelor: ["Bachelor's Degree", "Bachelor of Computer Science"],
      "Bachelor of Computer Science": ["Bachelor of Computer Science"],
    },
    offered: ["Bachelor of Computer Science", "Bachelor's Degree"],
    queries: [
      "Bachelor Computer Science",
      "Bachelor Computer",
      "Bachelor",
      "Bac",
    ],
  },
  {
    name: "a single word's prefix when the full spelling has no results",
    value: "Prishtina",
    results: { Pri: ["Pristina", "Prizren"], Pristina: ["Pristina"] },
    offered: ["Pristina", "Prizren"],
    queries: ["Prishtina", "Pri"],
  },
])(
  "remote search offers $name, never chooses it until an exact retry",
  async ({ value, results, offered, queries }) => {
    await withPage(async (page) => {
      await page.setContent(remotePicker(results));
      const control = page.getByRole("combobox");
      expect(await choosePageOption(page, control, value)).toMatchObject({
        ok: false,
        reason: "option_not_offered",
        offeredOptions: offered,
      });
      expect(await page.evaluate("window.queries.filter(Boolean)")).toEqual(
        queries,
      );
      expect(await control.inputValue()).toBe("");
      expect(await control.getAttribute("data-committed")).toBe("");
      expect(await choosePageOption(page, control, offered[0]!)).toEqual({
        ok: true,
        observedValue: offered[0],
      });
      expect(await control.inputValue()).toBe(offered[0]);
      expect(await control.getAttribute("data-committed")).toBe(offered[0]);
    });
  },
  30_000,
);

test("an exact remote result that the field drops on blur is not a successful selection", async () => {
  await withPage(async (page) => {
    await page.setContent(remotePicker({ Pristina: ["Pristina"] }, true));
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      "Pristina",
    );
    expect(result).toEqual({
      ok: false,
      error: 'The list did not keep "Pristina" selected.',
    });
  });
});

test("a windowed list with no scroll box of its own is not read as complete", async () => {
  // 300 rows, 12 drawn, each saying where it sits and how many there are;
  // nothing in reach scrolls, so the first window is all that can be seen.
  await withPage(async (page) => {
    await page.setContent(`
      <label>Country<input role="combobox" readonly aria-controls="window-options"></label>
      <div style="height:240px;overflow:hidden"><div><div><div id="window-options" role="listbox">
        ${longList
          .slice(0, 12)
          .map(
            (text, index) =>
              `<div role="option" aria-setsize="${longList.length}" aria-posinset="${index + 1}">${text}</div>`,
          )
          .join("")}
      </div></div></div></div>`);
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      longList[replay.longListWantedIndex]!,
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("reason");
  });
}, 30_000);
