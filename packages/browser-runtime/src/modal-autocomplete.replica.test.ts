import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeAll, afterAll, expect, test } from "vitest";
import {
  createPlaywrightApplyPageMechanics,
  readRawApplyPage,
} from "./apply-page-mechanics";

// Bundle the desktop's actual React dependencies into a local synthetic page.
const desktop = path.resolve(import.meta.dirname, "../../../apps/desktop");
const requireDesktop = createRequire(path.join(desktop, "package.json"));
const bundler = createRequire(requireDesktop.resolve("vite"))("esbuild") as {
  buildSync(options: Record<string, unknown>): {
    outputFiles: { text: string }[];
  };
};
const script = bundler.buildSync({
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  stdin: {
    resolveDir: desktop,
    contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  const h=React.createElement;
  function Picker({name,choices}) {
    const [value,setValue]=React.useState(''),[options,setOptions]=React.useState([]),[open,setOpen]=React.useState(false),[busy,setBusy]=React.useState(false);
    const timer=React.useRef();
    function change(e){const text=e.target.value;setValue(text);setBusy(true);setOpen(true);clearTimeout(timer.current);timer.current=setTimeout(()=>{setOptions(choices.filter(x=>x.toLowerCase().includes(text.toLowerCase())));setBusy(false)},250)}
    return h('label',null,name,h('input',{id:name,role:'combobox','aria-controls':name+'-list','aria-expanded':open,'aria-busy':busy,value,onChange:change,onFocus:()=>{setOpen(true);setOptions(choices)}}),open&&h('div',{id:name+'-list',role:'listbox','aria-busy':busy},options.map(text=>h('div',{key:text,role:'option',onClick:()=>{setValue(text);setOpen(false)}},text))));
  }
  function App(){const [open,setOpen]=React.useState(true),[date,setDate]=React.useState('11/06/2026'),[salary,setSalary]=React.useState('3000');
    React.useEffect(()=>{const close=e=>{if(e.key==='Escape')setOpen(false)};document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close)},[]);
    return h('div',{id:'backdrop',onClick:e=>{if(e.target===e.currentTarget)setOpen(false)}},open&&h('div',{role:'dialog'},h('label',null,'Date',h('input',{id:'date',value:date,onChange:e=>setDate(e.target.value)})),h('label',null,'Salary',h('input',{id:'salary',value:salary,onChange:e=>setSalary(e.target.value)})),h(Picker,{name:'Location',choices:['Pristina, Kosovo','London, UK']}),h(Picker,{name:'Experience',choices:['8 years','10 years']}),h('input',{id:'native-date',type:'date'}),h('div',{id:'rich',contentEditable:true}),h('input',{id:'offcanvas',style:{position:'absolute',left:'-10000px'},'aria-label':'Website'}),h('div',{'aria-hidden':true},h('input',{id:'hidden',style:{display:'none'}}))));
  }
  createRoot(document.getElementById('root')).render(h(App));`,
  },
}).outputFiles[0]!.text;
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test("React modal: reads, exact replacements and asynchronous option clicks preserve the dialog and answers", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.getByRole("dialog").waitFor();
    const hands = createPlaywrightApplyPageMechanics(page);
    const ref = async (id: string) =>
      (await readRawApplyPage(page)).controls.find((entry) => entry.id === id)!
        .ref!;
    const date = await ref("date"),
      salary = await ref("salary");
    await hands.fillText(date, "06.11.2026");
    expect(await page.locator("#date").inputValue()).toBe("06.11.2026");
    // Native background focus can stay on the previous input. Element-bound
    // writes must still update the requested field and its React state.
    await page.locator("#salary").evaluate((element) => {
      (element as HTMLElement).focus = () => {};
    });
    expect(await hands.fillText(salary, "EUR 4000")).toMatchObject({
      ok: true,
      observedValue: "EUR 4000",
    });
    expect(await page.locator("#date").inputValue()).toBe("06.11.2026");
    expect(
      await hands.fillText(await ref("native-date"), "2026-11-06"),
    ).toMatchObject({ ok: true, observedValue: "2026-11-06" });
    expect(
      await hands.fillText(await ref("rich"), "Complete answer"),
    ).toMatchObject({
      ok: true,
      observedValue: "Complete answer",
    });
    expect(await hands.fillText(await ref("Location"), "Pris")).toMatchObject({
      ok: true,
      observedValue: "Pris",
    });
    await readRawApplyPage(page);
    expect(await page.getByRole("dialog").count()).toBe(1);
    expect(
      await hands.chooseOption(await ref("Location"), "Pristina, Kosovo"),
    ).toMatchObject({ ok: true, observedValue: "Pristina, Kosovo" });
    expect(
      await hands.chooseOption(await ref("Experience"), "8 years"),
    ).toMatchObject({ ok: true, observedValue: "8 years" });
    const raw = await readRawApplyPage(page);
    expect(await page.getByRole("dialog").count()).toBe(1);
    expect(await page.locator("#salary").inputValue()).toBe("EUR 4000");
    expect(
      raw.controls.find((entry) => entry.id === "offcanvas")?.visibility,
    ).toMatchObject({ inViewport: false, offCanvas: true, zeroSize: false });
    expect(
      raw.controls.find((entry) => entry.id === "hidden")?.visibility,
    ).toMatchObject({
      inViewport: false,
      zeroSize: true,
      ariaHidden: true,
      cssHidden: true,
    });
    await page.keyboard.press("Escape");
    expect(await page.getByRole("dialog").count()).toBe(0);
  } finally {
    await page.close();
  }
});
