// Synthetic rich-text writing boxes. `/rich-text/apply/1` is a careers form
// whose cover letter is an editor that keeps its own document, the way
// ProseMirror, Lexical and Quill do: it cancels the browser's edit and
// applies each insertText and insertParagraph itself, and submits its
// paragraphs joined by line breaks. `/rich-text/compose` is a mail compose
// window in Gmail's shape: a plain contenteditable body where each line is
// the browser's own block, sent as its lines and its HTML.

const coverPage = `<!doctype html><title>Rich text replica</title>
<main><h1>Apply: Product Engineer at Paper Lantern</h1>
<form id="apply" action="/rich-text/apply/1" method="post">
  <p><label for="name">Full name*</label><input id="name" name="name" required></p>
  <p><span id="cover-label">Cover letter*</span></p>
  <div id="cover" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="cover-label" style="min-height:6em;border:1px solid #999;padding:4px"><p><br></p></div>
  <input type="hidden" id="cover_letter" name="cover_letter">
  <button>Submit application</button>
</form></main>
<script>
  const editor = document.getElementById('cover');
  const hidden = document.getElementById('cover_letter');
  let paragraphs = [''];
  const render = () => {
    editor.replaceChildren(...paragraphs.map((text) => {
      const p = document.createElement('p');
      if (text) p.textContent = text; else p.append(document.createElement('br'));
      return p;
    }));
    const range = document.createRange();
    range.selectNodeContents(editor.lastChild);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    hidden.value = paragraphs.join('\\n');
  };
  const selectsEverything = () => {
    const selection = getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return range.toString().replace(/\\s/g, '') === editor.textContent.replace(/\\s/g, '');
  };
  editor.addEventListener('beforeinput', (event) => {
    event.preventDefault();
    if (selectsEverything()) paragraphs = [''];
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') {
      paragraphs[paragraphs.length - 1] += event.data ?? '';
    } else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      paragraphs.push('');
    } else if (event.inputType.startsWith('delete') && !selectsEverything()) {
      const last = paragraphs.length - 1;
      if (paragraphs[last]) paragraphs[last] = paragraphs[last].slice(0, -1);
      else if (last > 0) paragraphs.pop();
    }
    render();
  });
</script>`;

const composePage = `<!doctype html><title>Compose Mail - synthetic@example.test - Mail</title>
<main><h1>New Message</h1>
  <p><label for="to">To recipients</label><input id="to" value="jobs@paper-lantern.test"></p>
  <p><label for="subject">Subject</label><input id="subject" value="Product Engineer application"></p>
  <div id="body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message Body" style="min-height:10em;border:1px solid #999;padding:4px"><div><br></div></div>
  <div role="button" tabindex="0" id="send">Send</div>
  <div id="status" role="status"></div>
</main>
<script>
  document.getElementById('send').addEventListener('click', async () => {
    const body = document.getElementById('body');
    const response = await fetch('/rich-text/compose', {
      method: 'POST',
      body: new URLSearchParams({
        to: document.getElementById('to').value,
        subject: document.getElementById('subject').value,
        // One line per block, as a mail client turns the body into text.
        body: [...body.children].map((line) => line.textContent).join('\\n'),
        html: body.innerHTML,
      }),
    });
    document.getElementById('status').textContent = response.ok ? 'Message sent' : 'Message not sent';
  });
</script>`;

export async function handleRichText(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname === "/rich-text/apply/1") {
    if (req.method === "POST") {
      const fields = await readPost(req);
      logPost(url.pathname, fields);
      const valid = Boolean(fields.name?.trim() && fields.cover_letter?.trim());
      send(
        valid ? 200 : 422,
        valid
          ? "<h1>Thank you! Your application has been received.</h1>"
          : "<h1>Please write a cover letter.</h1>",
      );
      return true;
    }
    send(200, coverPage);
    return true;
  }
  if (url.pathname === "/rich-text/compose") {
    if (req.method === "POST") {
      const fields = await readPost(req);
      logPost(url.pathname, fields);
      send(200, JSON.stringify({ sent: true }), "application/json");
      return true;
    }
    send(200, composePage);
    return true;
  }
  return false;
}
