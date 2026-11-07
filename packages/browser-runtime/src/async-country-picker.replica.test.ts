import { createServer } from "node:http";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { choosePageOption } from "./choose-page-option";

test("an async country list reads slotted names and ignores empty decoration after loading", async () => {
  let fetches = 0;
  const server = createServer((request, response) => {
    if (request.url === "/countries") {
      fetches++;
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(["Kosovo", "Germany"]));
      }, 6200);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><button role="combobox" aria-controls="countries">Phone country</button><div role="listbox" id="countries" style="display:none"></div><script>
      customElements.define('country-row', class extends HTMLElement {connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<div role="option"><slot></slot></div>';this.onclick=()=>{document.querySelector('button').textContent=this.textContent;document.querySelector('[role=listbox]').style.display='none'}}});
      document.querySelector('button').onclick=async()=>{const list=document.querySelector('[role=listbox]');list.style.display='block';if(list.dataset.loaded)return;list.setAttribute('aria-busy','true');for(const name of await (await fetch('/countries')).json()){const row=document.createElement('country-row');row.textContent=name;list.append(row)};list.insertAdjacentHTML('beforeend','<div class="loading-decoration" style="height:5px"></div><div role="option" aria-hidden="true" style="height:5px"></div>');list.dataset.loaded='yes';list.setAttribute('aria-busy','false')};
    </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const control = page.getByRole("combobox");
    expect(await choosePageOption(page, control, "Kosovo")).toMatchObject({
      ok: true,
      observedValue: "Kosovo",
    });
    expect(await control.innerText()).toBe("Kosovo");
    expect(await choosePageOption(page, control, "Atlantis")).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: ["Kosovo", "Germany"],
    });
    expect(fetches).toBe(1);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
