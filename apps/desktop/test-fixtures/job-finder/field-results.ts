import type { IncomingMessage, ServerResponse } from "node:http";

export const fieldResultsForm = `<!doctype html><title>Application replica</title>
<form action="/send" method="post"><input type="hidden" name="callingCode" value="+49">
<label>Email<input name="email" type="email" required></label>
<label>Terms<input name="terms" type="checkbox" required style="opacity:0"></label>
<label for="na">N/A</label><input id="na" name="answer" type="radio" value="N/A" required>
<button type="button" role="combobox" aria-label="Calling code" aria-controls="codes" aria-expanded="false">Germany</button>
<div id="codes" role="listbox" hidden><div id="scroll" style="height:160px;overflow:auto;position:relative"><div style="height:2400px"></div></div></div>
<label>Phone<input name="phone" type="tel" required></label>
<button>Send application</button></form>
<script>
const picker=document.querySelector('[role=combobox]'),list=document.getElementById('codes'),scroll=document.getElementById('scroll');
const choices=Array.from({length:60},(_,i)=>i===35?'Kosovo':'Region '+i);
let loaded=false;
function draw(){if(!loaded)return;scroll.querySelectorAll('[role=option]').forEach(e=>e.remove());const first=Math.floor(scroll.scrollTop/40);choices.slice(first,first+6).forEach((text,i)=>{const row=document.createElement('div');row.setAttribute('role','option');row.setAttribute('aria-setsize',choices.length);row.textContent=text;row.style.cssText='position:absolute;height:40px;top:'+(first+i)*40+'px';row.onclick=()=>{picker.textContent=text;picker.setAttribute('aria-expanded','false');list.hidden=true;document.querySelector('[name=phone]').value='+383';document.querySelector('[name=callingCode]').value='+383';};scroll.appendChild(row);});}
picker.onclick=()=>{const open=picker.getAttribute('aria-expanded')!=='true';picker.setAttribute('aria-expanded',String(open));list.hidden=!open;if(open){list.setAttribute('aria-busy','true');setTimeout(()=>{loaded=true;list.removeAttribute('aria-busy');draw();},900);}};
scroll.onscroll=draw;
</script>`;

/** Acceptance proves the sent fields, independently of the browser's report. */
export function acceptFieldResultsSubmission(
  request: IncomingMessage,
  response: ServerResponse,
  accepted: () => void,
): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    const fields = new URLSearchParams(body);
    const valid =
      fields.get("email") === "test@example.test" &&
      fields.get("terms") === "on" &&
      fields.get("answer") === "N/A" &&
      fields.get("callingCode") === "+383" &&
      fields.get("phone") === "+383 44 000 000";
    if (valid) accepted();
    response.statusCode = valid ? 200 : 422;
    response.end(
      valid
        ? "<h1>Application received</h1>"
        : "<h1>Invalid application fields</h1>",
    );
  });
}
