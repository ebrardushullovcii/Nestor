import replay from "../job-finder/apply-replays/handover-options.json" with { type: "json" };
export async function handleHandoverOptions(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname !== "/handover-options/apply/1") return false;
  if (req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    send(200, "<h1>Thank you! Your application has been received.</h1>");
    return true;
  }
  const sessions = Array.from(
    { length: replay.longListSize },
    (_, index) => `Session ${String(index + 1).padStart(3, "0")}`,
  );
  const employmentShape = url.searchParams.has("employment");
  const firstId = employmentShape ? "country" : "session";
  const firstPrompt = employmentShape
    ? "What is your current country of residence?"
    : "Which interview session would you prefer?";
  send(
    200,
    `<!doctype html><title>Question-owned choices</title><main><h1>Apply: Question-owned choice replay</h1>
 <form method="post" action="${url.pathname}" enctype="multipart/form-data">
 <p><label for="${firstId}">${firstPrompt}</label><input id="${firstId}" name="${firstId}" role="combobox" aria-expanded="false" aria-controls="shared" required readonly></p>
 <p><label for="restrictions">${replay.restrictionPrompt}</label><input id="restrictions" name="restrictions" role="combobox" aria-expanded="false" aria-controls="shared" required readonly></p>
 ${employmentShape ? `<p><label for="previous">${replay.previousEmploymentPrompt}</label><input id="previous" name="previous" role="combobox" aria-expanded="false" aria-controls="shared" required readonly></p>` : ""}
 <div id="shared" role="listbox" hidden style="max-height:250px;overflow:auto;border:1px solid"></div>
 <p><label for="resume">Resume</label><input id="resume" name="resume" type="file" accept=".pdf" required></p><button>Submit application</button></form></main><script>
 const choices=${JSON.stringify({ [firstId]: employmentShape ? replay.countryOptions : sessions, restrictions: replay.restrictionOptions, ...(employmentShape ? { previous: replay.previousEmploymentOptions } : {}) })};
 const menu=document.getElementById('shared'); let active=null, revision=0;
 for(const id of Object.keys(choices)) {
   const input=document.getElementById(id);
   input.onclick=()=>{
     active=input; const current=++revision; input.setAttribute('aria-expanded','true');menu.hidden=false;
     setTimeout(()=>{
       if(current!==revision) return;
       menu.innerHTML=choices[id].map(label=>'<div role="option" tabindex="0">'+label+'</div>').join('');
       menu.querySelectorAll('[role="option"]').forEach(option=>option.onclick=()=>{input.value=option.textContent;input.dispatchEvent(new Event('change',{bubbles:true}));input.setAttribute('aria-expanded','false');menu.hidden=true;});
     },80);
   };
 }
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){revision++;document.querySelectorAll('[role="combobox"]').forEach(input=>input.setAttribute('aria-expanded','false'));menu.hidden=true;}});
 </script>`,
  );
  return true;
}
