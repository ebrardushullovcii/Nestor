// Synthetic Greenhouse-shaped form with voluntary self-identification
// dropdowns, drawn the way React-Select draws them (Cloudflare, R6 run 04):
// an input with role combobox, a menu that names itself only while open, a
// filter that keeps every option containing the typed text ("Male" also
// shows "Female"), and a menu that scrolls the page over several frames when
// it opens below the fold. `?hydrate=<ms>` redraws the whole form that long
// after load, the way a client-rendered page replaces its server HTML, and
// `?background=1` lands the menu's scroll on the frame the pointer's move
// draws, as a window drawn in the background does.
const QUESTIONS = [
  {
    name: "sponsorship",
    label:
      "Do you now or will you in the future require immigration sponsorship to work at this company?*",
    options: ["Yes", "No"],
    required: true,
  },
  {
    name: "gender",
    label: "Gender",
    options: ["Male", "Female", "Decline To Self Identify"],
  },
  {
    name: "hispanic",
    label: "Are you Hispanic/Latino?",
    options: ["Yes", "No", "Decline To Self Identify"],
  },
  {
    name: "veteran",
    label: "Veteran Status",
    options: [
      "I am not a protected veteran",
      "I identify as one or more of the classifications of a protected veteran",
      "I don't wish to answer",
    ],
  },
];

export async function handleSelfId(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname !== "/self-id/apply/1") return false;
  if (req.method === "POST") {
    const fields = await readPost(req);
    logPost(url.pathname, fields);
    const valid = !!fields.first_name && !!fields.sponsorship;
    send(
      valid ? 200 : 422,
      valid
        ? "<h1>Thank you for applying. Your application has been received.</h1>"
        : "<h1>Please complete the required fields.</h1>",
    );
    return true;
  }
  // Milliseconds after load at which the form is drawn again, or none.
  const hydrate = Number(url.searchParams.get("hydrate") ?? 0) || 0;
  // A background window draws fewer frames, so the menu's scroll lasts longer.
  const scrollMs = Number(url.searchParams.get("scrollMs") ?? 400) || 400;
  // A hidden window draws no frames until input arrives: the menu's scroll
  // then lands in the frame the pointer's own move produces.
  const background = url.searchParams.get("background") === "1";
  send(
    200,
    `<!doctype html><title>Job Application for Senior Design Engineer</title>
  <style>
    body { font: 14px sans-serif; margin: 0 auto; max-width: 640px; }
    .select__container { position: relative; }
    .select__control { display: flex; border: 1px solid #999; min-height: 38px; align-items: center; padding: 0 8px; }
    .select__value { flex: 1; position: relative; display: grid; }
    .select__value > * { grid-area: 1 / 1; }
    .select__input { border: 0; outline: 0; background: transparent; min-width: 2px; }
    .select__menu { position: absolute; top: 100%; left: 0; right: 0; background: #fff; border: 1px solid #ccc; z-index: 2; }
    .select__option { padding: 8px 12px; }
    .select__placeholder { color: #777; }
  </style>
  <main id="app"></main>
  <script>
    const QUESTIONS = ${JSON.stringify(QUESTIONS)};
    let instance = 0;
    const html = () => \`
      <h1>Senior Design Engineer</h1>
      <p style="height:1400px">About the role. A long description of the role that a person scrolls past.</p>
      <form action="/self-id/apply/1" method="post">
        <p><label for="first_name">First Name*</label><input id="first_name" name="first_name" required></p>
        <p><label for="last_name">Last Name*</label><input id="last_name" name="last_name" required></p>
        <p><label for="email">Email*</label><input id="email" name="email" type="email" required></p>
        <div id="q-sponsorship"></div>
        <p><label><input type="checkbox" id="privacy" name="privacy" value="1"> Acknowledge/Confirm</label></p>
        <h2>Voluntary Self-Identification</h2>
        <p>For government reporting purposes, we ask candidates to respond to the below self-identification survey.</p>
        <div id="q-gender"></div>
        <div id="q-hispanic"></div>
        <div id="q-veteran"></div>
        <button>Submit application</button>
      </form>\`;
    // React-Select scrolls the page so an opened menu fits, over several frames.
    const animateScroll = (to, duration) => {
      if (${background}) {
        addEventListener('pointermove', () => { scrollTo(0, to); window.__menuScrolls = (window.__menuScrolls ?? 0) + 1; }, { capture: true, once: true });
        return;
      }
      const from = scrollY;
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        scrollTo(0, from + (to - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(step);
        else window.__menuScrolls = (window.__menuScrolls ?? 0) + 1;
      };
      requestAnimationFrame(step);
    };
    const mount = (question) => {
      const id = 'react-select-' + ++instance;
      const host = document.getElementById('q-' + question.name);
      host.innerHTML = \`<label id="\${id}-label" for="\${question.name}">\${question.label}</label>
        <div class="select__container">
          <div class="select__control">
            <div class="select__value">
              <div class="select__placeholder" id="\${id}-placeholder">Select...</div>
              <input class="select__input" id="\${question.name}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="\${id}-label" aria-describedby="\${id}-placeholder" autocomplete="off" \${question.required ? 'aria-required="true"' : ''}>
            </div>
            <span aria-hidden="true">▾</span>
          </div>
          <input type="hidden" name="\${question.name}">
        </div>\`;
      const control = host.querySelector('.select__control');
      const input = host.querySelector('.select__input');
      const valueBox = host.querySelector('.select__value');
      const placeholder = host.querySelector('.select__placeholder');
      const hidden = host.querySelector('input[type=hidden]');
      let menu = null;
      const close = () => {
        menu?.remove();
        menu = null;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-controls');
        input.removeAttribute('aria-activedescendant');
      };
      const choose = (text) => {
        hidden.value = text;
        input.value = '';
        placeholder.style.display = 'none';
        valueBox.querySelector('.select__single-value')?.remove();
        const shown = document.createElement('div');
        shown.className = 'select__single-value';
        shown.textContent = text;
        valueBox.prepend(shown);
        close();
      };
      const draw = () => {
        const query = input.value.trim().toLowerCase();
        const rows = question.options.filter((text) => text.toLowerCase().includes(query));
        const list = menu.querySelector('[role=listbox]');
        list.replaceChildren(...(rows.length ? rows.map((text, index) => {
          const row = document.createElement('div');
          row.className = 'select__option';
          row.id = id + '-option-' + index;
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', String(hidden.value === text));
          row.textContent = text;
          row.onclick = () => choose(text);
          return row;
        }) : [Object.assign(document.createElement('div'), { className: 'select__menu-notice', textContent: 'No options' })]));
      };
      const open = () => {
        if (menu) { draw(); return; }
        menu = document.createElement('div');
        menu.className = 'select__menu';
        menu.innerHTML = \`<div class="select__menu-list" role="listbox" id="\${id}-listbox"></div>\`;
        menu.addEventListener('mousedown', (event) => { event.preventDefault(); input.focus(); });
        host.querySelector('.select__container').append(menu);
        input.setAttribute('aria-expanded', 'true');
        input.setAttribute('aria-controls', id + '-listbox');
        draw();
        const overflow = menu.getBoundingClientRect().bottom - innerHeight;
        if (overflow > 0) animateScroll(scrollY + overflow + 8, ${scrollMs});
      };
      control.addEventListener('mousedown', (event) => {
        if (event.target !== input) event.preventDefault();
        input.focus();
        if (menu && event.target !== input) close(); else open();
      });
      input.addEventListener('input', () => {
        placeholder.style.display = input.value || hidden.value ? 'none' : '';
        open();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') { open(); event.preventDefault(); }
        if (event.key === 'Escape') { input.value = ''; close(); event.preventDefault(); }
      });
      input.addEventListener('blur', () => {
        input.value = '';
        placeholder.style.display = hidden.value ? 'none' : '';
        close();
      });
    };
    const render = () => {
      document.getElementById('app').innerHTML = html();
      for (const question of QUESTIONS) mount(question);
    };
    render();
    ${hydrate ? `setTimeout(() => { render(); window.__hydrated = true; }, ${hydrate});` : ""}
  </script>`,
  );
  return true;
}
