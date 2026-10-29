// Synthetic remote-search pickers: only nonempty queries expose choices.
const choices = {
  city: ["Cloud Harbor", "Cloud Hill", "Lantern Valley", "Berlin"],
  degree: ["Bachelor's Degree", "Master's Degree", "Doctorate"],
};

export async function handleRemoteSearch(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname === "/remote-search/options") {
    const field = url.searchParams.get("field");
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const rows = (choices[field] ?? []).filter(
      (text) =>
        query &&
        (text.toLowerCase().includes(query) ||
          (field === "degree" &&
            query === "bsc" &&
            text === "Bachelor's Degree")),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    send(200, JSON.stringify(rows), "application/json");
    return true;
  }
  if (url.pathname !== "/remote-search/apply/1") return false;
  if (req.method === "POST") {
    const fields = await readPost(req);
    logPost(url.pathname, fields);
    const valid = Object.entries(choices).every(([field, rows]) =>
      rows.includes(fields[field]),
    );
    send(
      valid ? 200 : 422,
      valid
        ? "<h1>Thank you! Your application has been received.</h1>"
        : "<h1>Choose a listed city and degree.</h1>",
    );
    return true;
  }
  send(
    200,
    `<!doctype html><title>Remote search replica</title>
  <main><h1>Apply: Platform Engineer at Cloud Tools</h1>
  <form action="/remote-search/apply/1" method="post">
    ${Object.keys(choices)
      .map(
        (
          id,
        ) => `<p><label for="${id}">${id === "city" ? "City" : "Degree"}*</label>
      <input id="${id}" name="${id}" role="combobox" aria-controls="${id}-options" aria-expanded="false" required autocomplete="off">
      <span id="${id}-options" role="listbox" hidden></span></p>`,
      )
      .join("")}
    <button>Submit application</button>
  </form></main>
  <script>
    for (const input of document.querySelectorAll('input[role="combobox"]')) {
      const list = document.getElementById(input.id + '-options');
      let version = 0, committed = '';
      const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
      input.addEventListener('input', async () => {
        committed = '';
        const current = ++version;
        const query = input.value;
        list.replaceChildren();
        if (!query) { close(); return; }
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        list.setAttribute('aria-busy', 'true');
        const rows = await fetch('/remote-search/options?field=' + input.id + '&q=' + encodeURIComponent(query)).then((res) => res.json());
        if (version !== current) return;
        list.removeAttribute('aria-busy');
        for (const text of rows) {
          const row = document.createElement('div');
          row.setAttribute('role', 'option');
          row.textContent = text;
          row.onmousedown = (event) => event.preventDefault();
          row.onclick = () => { committed = text; input.value = text; close(); };
          list.appendChild(row);
        }
        if (!rows.length) list.textContent = 'No results';
      });
      input.addEventListener('blur', () => { input.value = committed; close(); });
      input.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    }
  </script>`,
  );
  return true;
}
