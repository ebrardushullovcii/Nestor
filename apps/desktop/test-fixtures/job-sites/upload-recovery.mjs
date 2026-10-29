// Synthetic attachment widgets. No employer traffic or applicant data.
const tries = new Map();
export async function handleUploadRecovery(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  const shapes = [
    "chooser",
    "drop",
    "slow",
    "transient",
    "stale",
    "refused",
    "vanished",
  ];
  if (url.pathname === "/upload-recovery/") {
    send(
      200,
      `<!doctype html><h1>Upload Recovery Workshop jobs</h1>${shapes.map((shape) => `<article><h2><a href="/upload-recovery/${shape}/jobs/1">Frontend Engineer — ${shape}</a></h2><p>Synthetic Workshop · Remote, Germany · Posted today</p><p>Build TypeScript and React document interfaces.</p></article>`).join("")}`,
    );
    return true;
  }
  const job = /^\/upload-recovery\/(\w+)\/jobs\/1$/u.exec(url.pathname);
  if (job && shapes.includes(job[1])) {
    send(
      200,
      `<!doctype html><h1>Frontend Engineer — ${job[1]}</h1><p>Synthetic Workshop · Remote, Germany</p><p>Build TypeScript and React document interfaces. Full time, senior frontend engineering with accessible UI, testing and web performance.</p><a href="/upload-recovery/${job[1]}/apply/1">Apply</a>`,
    );
    return true;
  }
  const match =
    /^\/upload-recovery\/(chooser|drop|slow|transient|stale|refused|vanished)\/(apply|attachments)\/(\w+)$/u.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, shape, action, id] = match;
  if (req.method === "POST") {
    const fields = await readPost(req);
    logPost(url.pathname, fields);
    if (action !== "attachments") {
      send(403, "No submission in this fixture");
      return true;
    }
    const key = `${shape}/${id}`;
    const count = (tries.get(key) ?? 0) + 1;
    tries.set(key, count);
    if (shape === "slow")
      await new Promise((resolve) => setTimeout(resolve, 6_000));
    const refused =
      shape === "refused" || (shape === "transient" && count === 1);
    send(
      refused ? 503 : 200,
      JSON.stringify(
        refused
          ? { error: "Document service unavailable" }
          : { fileId: "synthetic-file-123", uploaded: true },
      ),
      "application/json",
    );
    return true;
  }
  send(
    200,
    `<!doctype html><title>Upload recovery workshop</title>
    <h1>Apply: Synthetic Document Engineer</h1>
    <form><div class="field"><p>Documents</p><div id="zone" style="border:2px dashed;padding:20px">
      <label for="resume">Resume</label>
      <input id="resume" name="resume" type="file" accept=".pdf,.txt" style="display:none" aria-describedby="feedback">
      <button type="button" id="choose">Choose a file or drop it here</button>
      <span id="chip"></span><p id="feedback">${shape === "stale" ? "Your file upload failed on the previous attempt" : "PDF accepted"}</p>
    </div></div><button>Send application</button></form>
    <script>
      const input = document.getElementById('resume'), zone = document.getElementById('zone');
      const feedback = document.getElementById('feedback'), chip = document.getElementById('chip');
      let choosing = false;
      document.getElementById('choose').onclick = () => { choosing = true; input.click(); };
      async function attach(file, method) {
        input.value = '';
        if (${JSON.stringify(shape)} === 'vanished') return;
        if ((${JSON.stringify(shape)} === 'chooser' && !choosing) || (${JSON.stringify(shape)} === 'drop' && method !== 'drop')) {
          feedback.textContent = 'Your file was not accepted. Use the attachment control.';
          input.setAttribute('aria-invalid', 'true'); return;
        }
        choosing = false; input.removeAttribute('aria-invalid');
        feedback.textContent = 'Uploading and processing'; chip.textContent = '';
        const body = new FormData(); body.append('resume', file);
        let response;
        try { response = await fetch('/upload-recovery/${shape}/attachments/${id}?signature=synthetic-private-query', { method: 'POST', body }); }
        catch { feedback.textContent = 'Your file upload failed: Document service unavailable'; input.setCustomValidity('Document service unavailable'); return; }
        if (!response.ok) { feedback.textContent = 'Your file upload failed: Document service unavailable'; input.setCustomValidity('Document service unavailable'); return; }
        if (${JSON.stringify(shape)} === 'slow') await new Promise(resolve => setTimeout(resolve, 4_000));
        input.setCustomValidity(''); feedback.textContent = 'File attached'; chip.textContent = file.name;
        zone.dataset.attached = method;
      }
      input.onchange = () => { if (input.files[0]) attach(input.files[0], choosing ? 'chooser' : 'input'); };
      zone.addEventListener('dragover', event => event.preventDefault());
      zone.addEventListener('drop', event => { event.preventDefault(); if (event.dataTransfer.files[0]) attach(event.dataTransfer.files[0], 'drop'); });
    </script>`,
  );
  return true;
}
