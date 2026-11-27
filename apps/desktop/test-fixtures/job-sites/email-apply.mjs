// A synthetic posting applied to by email. `/email-apply/jobs/1` is a
// listing whose only Apply link is a mailto: address, as on small startup
// boards. `/email-apply/mail` is a mail compose window in Gmail's shape: it
// takes `to`, `su` and `body` from its address as Gmail's compose link does,
// has an "Attach files" input, and Send posts the message with its files.

const listingPage = `<!doctype html><title>Founding Engineer at Quill Harbor</title>
<main><h1>Founding Engineer</h1>
  <p>Quill Harbor (fictional) · Remote, Europe · Full-time</p>
  <p>Quill Harbor builds a calm planning tool for small teams. As our first engineer you will own the TypeScript and React front end and the Node.js API behind it.</p>
  <h2>What we look for</h2>
  <ul><li>Several years of TypeScript and React</li><li>Comfort owning features end to end</li></ul>
  <h2>How to apply</h2>
  <p>Email your CV to jobs@quill-harbor.test with a few lines about something you built. We reply to every application.</p>
  <p><a class="button" href="mailto:jobs@quill-harbor.test?subject=Founding%20Engineer%20application">Apply by email</a></p>
</main>`;

const composePage = (
  to,
  subject,
  body,
) => `<!doctype html><title>Compose Mail - Mail</title>
<main><h1>New Message</h1>
  <p><label for="to">To recipients</label><input id="to" value="${escape(to)}"></p>
  <p><label for="subject">Subject</label><input id="subject" value="${escape(subject)}"></p>
  <div id="body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message Body" style="min-height:10em;border:1px solid #999;padding:4px">${
    body
      ? body
          .split("\n")
          .map((line) => `<div>${escape(line) || "<br>"}</div>`)
          .join("")
      : "<div><br></div>"
  }</div>
  <p><label for="files">Attach files</label><input id="files" type="file" multiple></p>
  <div role="button" tabindex="0" id="send">Send</div>
  <div id="status" role="status"></div>
</main>
<script>
  document.getElementById('send').addEventListener('click', async () => {
    const body = document.getElementById('body');
    const form = new FormData();
    form.set('to', document.getElementById('to').value);
    form.set('subject', document.getElementById('subject').value);
    // One line per block, as a mail client turns the body into text.
    form.set('body', [...body.children].map((line) => line.textContent).join('\\n'));
    for (const file of document.getElementById('files').files) form.append('attachment', file);
    const response = await fetch('/email-apply/mail', { method: 'POST', body: form });
    document.getElementById('status').textContent = response.ok ? 'Message sent' : 'Message not sent';
  });
</script>`;

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function handleEmailApply(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname === "/email-apply/jobs/1") {
    send(200, listingPage);
    return true;
  }
  if (url.pathname === "/email-apply/mail") {
    if (req.method === "POST") {
      const fields = await readPost(req);
      logPost(url.pathname, fields);
      send(200, JSON.stringify({ sent: true }), "application/json");
      return true;
    }
    const params = url.searchParams;
    send(
      200,
      composePage(
        params.get("to") ?? "",
        params.get("su") ?? "",
        params.get("body") ?? "",
      ),
    );
    return true;
  }
  return false;
}
