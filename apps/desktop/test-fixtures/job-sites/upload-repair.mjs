// A transient server rejection: selecting a file locally does not attach it.
// Each form refuses its first upload with HTTP 422 and accepts the next. The
// chip shows the file name the moment it is picked, before the server
// answers, and the refusal is a toast at the top of the page that stays up.
// Form 2 asks for the resume on step 1 of 2, so the refusal is out of sight
// by the time the form reaches its send button.
const uploads = new Map();
const title = "Document Service Engineer";
const company = "Paper Upload Workshop";

const toastAndChip = (form) => `
  const input = document.getElementById('resume');
  input.addEventListener('change', async () => {
    document.getElementById('chip').textContent = input.files[0].name;
    const body = new FormData();
    body.append('resume', input.files[0]);
    const response = await fetch('/upload-repair/attachments?form=${form}', { method: 'POST', body });
    if (!response.ok) document.getElementById('toast').textContent = 'Failed to upload your resume';
  });`;

const resumeField = `<div class="upload"><label for="resume">Resume *</label>
  <button type="button" onclick="document.getElementById('resume').click()">Attach</button>
  <input id="resume" name="resume" type="file" accept=".pdf" required style="position:absolute;width:1px;height:1px;opacity:0">
  <span id="chip"></span>
  <p><a href="#help">Trouble uploading? Upload error help</a></p></div>`;

const contact = `<p><label>Full name <input name="name" required></label></p>
  <p><label>Email <input name="email" type="email" required></label></p>`;

function formPage(id) {
  const head = `<!doctype html><title>Apply — ${company}</title>
    <div id="toast" role="status"></div>
    <h1>Apply: ${title}</h1><p>${company} · Remote, Worldwide</p>`;
  if (id === "1")
    return `${head}<form method="post" action="/upload-repair/apply/1" enctype="multipart/form-data">
      ${contact}${resumeField}<button>Send application</button>
    </form><script>${toastAndChip(1)}</script>`;
  return `${head}<form method="post" action="/upload-repair/apply/2" enctype="multipart/form-data">
    <section id="step1"><p aria-current="step">Step 1 of 2: Documents</p>${resumeField}
      <button type="button" id="next">Continue</button></section>
    <section id="step2" hidden><p>Step 2 of 2: Contact</p>${contact}<button>Send application</button></section>
  </form><script>${toastAndChip(2)}
    document.getElementById('next').addEventListener('click', () => {
      document.getElementById('step1').hidden = true;
      document.getElementById('step2').hidden = false;
    });
  </script>`;
}

export async function handleUploadRepair(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  if (!url.pathname.startsWith("/upload-repair/")) return false;
  if (req.method === "POST") {
    const fields = await readPost(req);
    logPost(url.pathname, fields);
    if (url.pathname === "/upload-repair/attachments") {
      const form = url.searchParams.get("form") ?? "1";
      const count = (uploads.get(form) ?? 0) + 1;
      uploads.set(form, count);
      send(
        count === 1 ? 422 : 200,
        JSON.stringify({ uploaded: count > 1 }),
        "application/json",
      );
    } else if (/^\/upload-repair\/apply\/[12]$/u.test(url.pathname)) {
      send(200, "<h1>Thank you! Your application has been received.</h1>");
    } else send(404, "Not found");
    return true;
  }
  const job = /^\/upload-repair\/jobs\/([12])$/u.exec(url.pathname);
  const apply = /^\/upload-repair\/apply\/([12])$/u.exec(url.pathname);
  if (job) {
    send(
      200,
      `<h1>${title}</h1><p>${company} · Remote, Worldwide</p><p>Build reliable document services.</p><a href="/upload-repair/apply/${job[1]}">Apply</a>`,
    );
  } else if (apply) {
    send(200, formPage(apply[1]));
  } else send(404, "Not found");
  return true;
}
