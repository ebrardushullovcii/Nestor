// Synthetic Greenhouse-shaped city box: a combobox that asks a geocoder as
// the person types. The geocoder knows the city under one spelling only
// ("Pristina"), the way the real one returned nothing for "Prishtina".
const CITY = "Pristina, Kosovo";

const fold = (value) =>
  value.normalize("NFD").replace(/[̀-ͯ]/gu, "").trim().toLowerCase();

export async function handleCityLookup(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname === "/city-lookup/geocode") {
    const text = fold(url.searchParams.get("text") ?? "");
    // Slower than a page settles on its own, so only waiting for the
    // lookup itself sees the answer.
    await new Promise((resolve) => setTimeout(resolve, 900));
    send(
      200,
      JSON.stringify({
        features: text.length >= 3 && fold(CITY).startsWith(text) ? [CITY] : [],
      }),
      "application/json",
    );
    return true;
  }
  if (url.pathname !== "/city-lookup/apply/1") return false;
  if (req.method === "POST") {
    const fields = await readPost(req);
    logPost(url.pathname, fields);
    const valid = fields.location === CITY;
    send(
      valid ? 200 : 422,
      valid
        ? "<h1>Thank you! Your application has been received.</h1>"
        : "<h1>Please enter your location.</h1>",
    );
    return true;
  }
  send(
    200,
    `<!doctype html><title>City lookup replica</title>
  <main><h1>Apply: Platform Engineer at Cloud Tools</h1>
  <form action="/city-lookup/apply/1" method="post">
    <p><label for="name">Full name*</label><input id="name" name="name" required></p>
    <p><label id="city-label" for="city">Location (City)*</label>
      <input id="city" role="combobox" aria-autocomplete="list" aria-haspopup="true" aria-expanded="false" aria-labelledby="city-label" autocomplete="off">
      <input id="location" name="location" tabindex="-1" aria-hidden="true" required style="opacity:0;position:absolute;width:1px;height:1px">
      <span id="city-menu" class="select__menu" hidden><span id="city-listbox" class="select__menu-list" role="listbox"></span></span></p>
    <button>Submit application</button>
  </form></main>
  <script>
    const input = document.getElementById('city');
    const menu = document.getElementById('city-menu');
    const list = document.getElementById('city-listbox');
    const hidden = document.getElementById('location');
    let version = 0, timer = 0, committed = '';
    const notice = (text) => {
      const row = document.createElement('div');
      row.className = 'select__menu-notice';
      row.textContent = text;
      list.replaceChildren(row);
    };
    const close = () => {
      menu.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-controls');
    };
    const choose = (text) => {
      committed = text; input.value = text; hidden.value = text; close();
    };
    input.addEventListener('input', () => {
      committed = ''; hidden.value = '';
      const current = ++version;
      clearTimeout(timer);
      if (!input.value) { close(); return; }
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', 'city-listbox');
      notice('Loading...');
      // Debounced, as the real lookup is: one request after typing pauses.
      timer = setTimeout(async () => {
        const query = input.value;
        const { features } = await fetch('/city-lookup/geocode?text=' + encodeURIComponent(query)).then((res) => res.json());
        if (version !== current) return;
        if (!features.length) { notice('No options'); return; }
        list.replaceChildren(...features.map((text, index) => {
          const row = document.createElement('div');
          row.id = 'city-option-' + index;
          row.setAttribute('role', 'option');
          row.textContent = text;
          row.onmousedown = (event) => event.preventDefault();
          row.onclick = () => choose(text);
          return row;
        }));
      }, 300);
    });
    input.addEventListener('keydown', (event) => {
      const first = list.querySelector('[role="option"]');
      if (event.key === 'ArrowDown' && first) { input.setAttribute('aria-activedescendant', first.id); event.preventDefault(); }
      if (event.key === 'Enter' && input.getAttribute('aria-activedescendant')) { choose(document.getElementById(input.getAttribute('aria-activedescendant')).textContent); event.preventDefault(); }
      if (event.key === 'Escape') close();
    });
    input.addEventListener('blur', () => { if (!committed) input.value = ''; close(); });
  </script>`,
  );
  return true;
}
