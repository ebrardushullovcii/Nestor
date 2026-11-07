// Synthetic canvas puzzle. The tiles have no text or DOM click targets.
const accepted = new Map();
export async function handleImageChallenge(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  if (!url.pathname.startsWith("/image-challenge/")) return false;
  const key = url.searchParams.get("scenario") || "default";
  if (url.pathname === "/image-challenge/state") {
    send(
      200,
      JSON.stringify({ accepted: accepted.get(key) || 0 }),
      "application/json",
    );
    return true;
  }
  if (url.pathname === "/image-challenge/puzzle") {
    send(
      200,
      `<!doctype html><style>body{margin:0;font:16px sans-serif}h2{font-size:16px;margin:0;height:40px}canvas{display:block}</style>
      <h2>Click the TWO red triangles.</h2><canvas width="300" height="200"></canvas><p id="status">Select two tiles</p>
      <script>
        const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d'), selected=new Set();
        function draw(){for(let i=0;i<6;i++){const x=(i%3)*100,y=Math.floor(i/3)*100;
          ctx.fillStyle=selected.has(i)?'#bbf7d0':'#eee';ctx.fillRect(x+2,y+2,96,96);ctx.beginPath();
          if(i===1||i===4){ctx.fillStyle='#e00000';ctx.moveTo(x+50,y+20);ctx.lineTo(x+80,y+80);ctx.lineTo(x+20,y+80);ctx.closePath();}
          else {ctx.fillStyle='#0055dd';ctx.arc(x+50,y+50,28,0,Math.PI*2);}ctx.fill();}}
        draw();canvas.addEventListener('click',event=>{
          if(!event.isTrusted)return;
          const r=canvas.getBoundingClientRect(), i=Math.floor((event.clientX-r.left)/100)+3*Math.floor((event.clientY-r.top)/100);
          selected.has(i)?selected.delete(i):selected.add(i);draw();
          if(selected.size===2){const solved=selected.has(1)&&selected.has(4);
            document.querySelector('#status').textContent=solved?'Challenge passed':'Please try again';
            parent.postMessage({type:'synthetic-puzzle',solved},'*');if(!solved){selected.clear();draw();}}
        });
      </script>`,
    );
    return true;
  }
  if (req.method === "POST") {
    const fields = await readPost(req);
    logPost(url.pathname, fields);
    if (fields.solved !== "yes" || !fields.name)
      send(400, "The image challenge or name is incomplete");
    else if (accepted.has(key)) send(409, "Application already received");
    else {
      accepted.set(key, 1);
      send(200, "Thank you! Your application has been received.");
    }
    return true;
  }
  const child = new URL(url.pathname, `http://${req.headers.host}`);
  child.hostname = url.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  child.pathname = "/image-challenge/puzzle";
  send(
    200,
    `<!doctype html><title>Synthetic Image Workshop</title><h1>Apply: Synthetic Canvas Engineer</h1>
    <form><label>Full name <input name="name" required></label><input type="hidden" name="solved" value="no">
    <iframe name="image-puzzle" src="${child}" style="display:block;width:320px;height:300px;border:0;margin:20px"></iframe>
    <p id="challenge-status">Complete the image challenge</p><button>Send application</button></form>
    <script>
      const form=document.querySelector('form');
      addEventListener('message',event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='synthetic-puzzle'){
        form.elements.solved.value=event.data.solved?'yes':'no';document.querySelector('#challenge-status').textContent=event.data.solved?'Challenge passed':'Please try again';}});
      form.onsubmit=async event=>{event.preventDefault();const response=await fetch(location.href,{method:'POST',body:new FormData(form)});
        const text=await response.text();if(response.ok)document.body.innerHTML='<h1>'+text+'</h1>';else document.querySelector('#challenge-status').textContent=text;};
    </script>`,
  );
  return true;
}
