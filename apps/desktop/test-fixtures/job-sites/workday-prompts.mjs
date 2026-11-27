// A five-step application in the shape of Workday's candidate forms (R8
// J.D. Power): prompt fields whose choices sit beside the search box as
// removable pills, in a list of their own, and whose results open in a list
// floated at the end of the page only after Enter; a phone code prompt that
// already holds a pill; a Skills prompt that keeps several; a progress bar
// that names every step ("completed step 1 of 5 … current step 2 of 5"); an
// upload confirmation in an alert region; one "Add" button per history block;
// choice rows that tick a box. Only the last step's Submit sends.

const sources = [
  "Agency",
  "Career Websites",
  "Employee Referral",
  "Job Board",
  "Other",
  "Social Referral",
];
const codes = [
  "Albania (+355)",
  "Germany (+49)",
  "Kosovo (+383)",
  "United Kingdom (+44)",
  "United States of America (+1)",
];
const skills = [
  ".NET Framework",
  "Amazon Web Services (AWS)",
  "Angular (Web Framework)",
  "C# (Programming Language)",
  "CSS",
  "Docker (Software)",
  "Git",
  "GraphQL",
  "HTML",
  "Java (Programming Language)",
  "JavaScript (Programming Language)",
  "Kubernetes",
  "Microsoft SQL Server",
  "MySQL",
  "Next.js",
  "Node.js",
  "NoSQL",
  "PostgreSQL",
  "Python (Programming Language)",
  "React (Software)",
  "React Native",
  "React Redux",
  "Reactive Programming",
  "REST APIs",
  "SQL (Programming Language)",
  "Terraform",
  "TypeScript",
  "TypoScript",
  "Vue.js",
];
const veteran = [
  "I am not a veteran",
  "I am a protected veteran",
  "I do not wish to self-identify",
];
const steps = [
  "My Information",
  "My Experience",
  "Application Questions",
  "Voluntary Disclosures",
  "Review",
];

const prompt = (id, label, required, multi, hint = "") =>
  `<div class="wd-field" data-automation-id="formField-${id}">
  <label id="${id}-label" for="${id}-search">${label}${required ? "<abbr title=required>*</abbr>" : ""}</label>
  ${hint ? `<p class="wd-hint">${hint}</p>` : ""}
  <div class="wd-prompt" data-prompt="${id}" data-multi="${multi}">
    <ul class="wd-pills" role="listbox" aria-labelledby="${id}-label" data-automation-id="selectedItemList"></ul>
    <input id="${id}-search" type="text" placeholder="Search" autocomplete="off" data-automation-id="searchBox">
  </div>
  <input type="hidden" name="${id}" value="">
</div>`;

const page =
  () => `<!doctype html><title>Platform Engineer — Velvet Prompt Careers</title>
<style>
  body { font-family: sans-serif; margin: 0 2rem 4rem; }
  .wd-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .wd-progress { display: flex; gap: 1.5rem; margin: 1rem 0; }
  .wd-field { margin: 1rem 0; max-width: 34rem; }
  .wd-prompt { border: 1px solid #888; padding: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
  .wd-pills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .wd-pills li { background: #e4ecf7; border-radius: 10px; padding: 2px 8px; }
  .wd-pills .wd-remove { cursor: pointer; margin-left: 4px; }
  .wd-prompt input { border: 0; flex: 1; min-width: 8rem; }
  .wd-popup { position: absolute; background: #fff; border: 1px solid #555; max-height: 16rem; overflow: auto; width: 30rem; z-index: 5; }
  .wd-popup [role=option] { padding: 4px 8px; cursor: pointer; }
  .wd-popup [role=option] .wd-box { display: inline-block; width: 12px; height: 12px; border: 1px solid #333; margin-right: 6px; }
  .wd-popup [role=option][aria-selected=true] .wd-box { background: #246; }
  .wd-ok { color: #1a6b1a; }
  .wd-errors { color: #a00; border: 1px solid #a00; padding: .5rem; }
</style>
<header><span>Careers</span></header>
<h2>Platform Engineer</h2>
<div class="wd-progress" data-automation-id="progressBar">
  ${steps.map((title, at) => `<div data-step-marker="${at}"><span class="wd-sr" data-step-state></span><span>${title}</span></div>`).join("")}
</div>
<div id="errors"></div>
<form id="wd-form" method="post" action="/workday-prompts/apply/1" enctype="multipart/form-data" novalidate>
<div data-step="0">
  <h2>My Information</h2>
  ${prompt("source", "How Did You Hear About Us?", true, false)}
  <div class="wd-field"><label for="given">Given Name<abbr title=required>*</abbr></label><input id="given" name="given"></div>
  <div class="wd-field"><label for="family">Family Name<abbr title=required>*</abbr></label><input id="family" name="family"></div>
  <div class="wd-field"><label for="email">Email<abbr title=required>*</abbr></label><input id="email" name="email" type="email"></div>
  ${prompt("phoneCode", "Country Phone Code", true, false)}
  <div class="wd-field"><label for="phone">Phone Number<abbr title=required>*</abbr></label><input id="phone" name="phone" type="tel"></div>
</div>
<div data-step="1" hidden>
  <h2>My Experience</h2>
  <section aria-label="My Experience">
    ${["Work Experience", "Education", "Languages", "Websites"]
      .map(
        (title) => `<div class="wd-block" data-block="${title}">
      <div class="wd-block-title">${title}</div>
      <div class="wd-rows"></div>
      <button type="button" data-add="${title}">Add</button>
    </div>`,
      )
      .join("")}
    ${prompt("skills", "Skills", false, true, "Type to add skills. Add 5 to 10 skills.")}
    <div class="wd-field"><label for="resume">Resume/CV<abbr title=required>*</abbr></label>
      <input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt">
      <div id="upload-status"></div></div>
  </section>
</div>
<div data-step="2" hidden>
  <h2>Application Questions</h2>
  <fieldset><legend>Are you legally authorized to work in the country of this role?<abbr title=required>*</abbr></legend>
    <label><input type="radio" name="authorized" value="Yes"> Yes</label>
    <label><input type="radio" name="authorized" value="No"> No</label></fieldset>
  <div class="wd-field"><label for="notice">What is your notice period?<abbr title=required>*</abbr></label><input id="notice" name="notice"></div>
</div>
<div data-step="3" hidden>
  <h2>Voluntary Disclosures</h2>
  ${prompt("veteran", "Veteran Status", true, false)}
  <div class="wd-field"><label><input type="checkbox" id="terms" name="terms" value="yes"> I consent to the terms and conditions<abbr title=required>*</abbr></label></div>
</div>
<div data-step="4" hidden>
  <h2>Review</h2>
  <dl id="review"></dl>
</div>
<p>
  <button type="button" id="back" hidden>Back</button>
  <button type="button" id="next">Save and Continue</button>
  <button type="submit" id="submit" hidden>Submit</button>
</p>
</form>
<script>
const choices = ${JSON.stringify({ source: sources, phoneCode: codes, skills, veteran })};
const form = document.getElementById('wd-form');
const held = { source: [], phoneCode: ['Kosovo (+383)'], skills: [], veteran: [] };
let popup = null;
const closePopup = () => { if (popup) { popup.hidden = true; popup.dataset.for = ''; } };
const commit = (id) => {
  form.elements.namedItem(id).value = JSON.stringify(held[id]);
  const list = document.querySelector('[data-prompt="' + id + '"] .wd-pills');
  list.replaceChildren(...held[id].map((text) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'presentation');
    const pill = document.createElement('div');
    pill.setAttribute('role', 'option');
    pill.setAttribute('aria-selected', 'false');
    pill.setAttribute('aria-label', text + ', press delete to clear value.');
    pill.tabIndex = -1;
    pill.textContent = text;
    pill.addEventListener('keydown', (event) => { if (event.key === 'Delete' || event.key === 'Backspace') { held[id] = held[id].filter((value) => value !== text); commit(id); } });
    const remove = document.createElement('span');
    remove.className = 'wd-remove';
    remove.setAttribute('aria-hidden', 'true');
    remove.textContent = '×';
    remove.onclick = () => { held[id] = held[id].filter((value) => value !== text); commit(id); };
    item.append(pill, remove);
    return item;
  }));
};
const open = (id, rows) => {
  const box = document.querySelector('[data-prompt="' + id + '"]');
  const multi = box.dataset.multi === 'true';
  if (!popup) {
    popup = document.createElement('div');
    popup.className = 'wd-popup';
    popup.setAttribute('data-automation-widget', 'wd-popup');
    document.body.append(popup);
    popup.addEventListener('mousedown', (event) => event.preventDefault());
  }
  const rect = box.getBoundingClientRect();
  popup.style.left = (rect.left + scrollX) + 'px';
  popup.style.top = (rect.bottom + scrollY + 2) + 'px';
  popup.dataset.for = id;
  popup.hidden = false;
  const list = document.createElement('div');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', String(multi));
  if (!rows.length) list.textContent = 'No Items.';
  for (const text of rows) {
    const row = document.createElement('div');
    row.setAttribute('role', 'option');
    row.tabIndex = -1;
    const draw = () => {
      const chosen = held[id].includes(text);
      row.setAttribute('aria-selected', String(chosen));
      row.innerHTML = '<span class="wd-box" aria-hidden="true"></span><span></span><span class="wd-sr"></span>';
      row.children[1].textContent = text;
      row.children[2].textContent = chosen ? 'checked' : 'not checked';
    };
    draw();
    row.addEventListener('redraw', draw);
    row.addEventListener('click', () => {
      if (multi) {
        held[id] = held[id].includes(text) ? held[id].filter((value) => value !== text) : [...held[id], text];
        draw();
      } else {
        held[id] = [text];
        for (const other of list.children) other.dispatchEvent(new Event('redraw'));
        closePopup();
      }
      document.getElementById(id + '-search').value = '';
      commit(id);
    });
    list.append(row);
  }
  popup.replaceChildren(list);
};
for (const box of document.querySelectorAll('[data-prompt]')) {
  const id = box.dataset.prompt;
  const input = document.getElementById(id + '-search');
  // A prompt with a short list shows it when opened; Skills shows nothing
  // until a search runs.
  input.addEventListener('click', () => { if (id !== 'skills') open(id, choices[id]); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const query = input.value.trim().toLowerCase();
      setTimeout(() => open(id, choices[id].filter((text) => text.toLowerCase().includes(query))), 400);
    }
    if (event.key === 'Escape') closePopup();
  });
  commit(id);
}
document.addEventListener('mousedown', (event) => {
  if (popup && !popup.contains(event.target) && !event.target.closest('[data-prompt]')) closePopup();
});
for (const button of document.querySelectorAll('[data-add]')) {
  button.addEventListener('click', () => {
    const block = button.dataset.add;
    const rows = button.parentElement.querySelector('.wd-rows');
    const n = rows.children.length + 1;
    const name = block.toLowerCase().replace(/\\W+/g, '');
    const fields = { 'Work Experience': ['Job Title', 'Company'], Education: ['School or University', 'Degree'], Languages: ['Language'], Websites: ['URL'] }[block];
    const row = document.createElement('div');
    row.innerHTML = '<div class="wd-row-title">' + block + ' ' + n + '</div>' + fields.map((label) => {
      const key = name + n + '_' + label.toLowerCase().replace(/\\W+/g, '');
      return '<div class="wd-field"><label for="' + key + '">' + label + '</label><input id="' + key + '" name="' + key + '"></div>';
    }).join('');
    rows.append(row);
  });
}
document.getElementById('resume').addEventListener('change', (event) => {
  const file = event.target.files[0];
  const status = document.getElementById('upload-status');
  status.innerHTML = file ? '<div role="alert" class="wd-ok"></div>' : '';
  if (file) status.firstChild.textContent = file.name + ' successfully uploaded';
});
let current = 0;
const show = (index) => {
  current = index;
  for (const step of document.querySelectorAll('[data-step]')) step.hidden = Number(step.dataset.step) !== index;
  for (const marker of document.querySelectorAll('[data-step-marker]')) {
    const at = Number(marker.dataset.stepMarker);
    marker.querySelector('[data-step-state]').textContent = (at < index ? 'completed ' : at === index ? 'current ' : '') + 'step ' + (at + 1) + ' of ${steps.length}';
  }
  document.getElementById('back').hidden = index === 0;
  document.getElementById('next').hidden = index === ${steps.length - 1};
  document.getElementById('submit').hidden = index !== ${steps.length - 1};
  closePopup();
  if (index === ${steps.length - 1}) {
    const data = new FormData(form);
    const rows = [['How Did You Hear About Us?', held.source.join(', ')], ['Name', data.get('given') + ' ' + data.get('family')], ['Phone', held.phoneCode.join('') + ' ' + data.get('phone')], ['Skills', held.skills.join(', ')], ['Resume/CV', data.get('resume')?.name ?? ''], ['Authorized', data.get('authorized') ?? ''], ['Notice period', data.get('notice')], ['Veteran Status', held.veteran.join('')]];
    document.getElementById('review').replaceChildren(...rows.flatMap(([label, value]) => { const dt = document.createElement('dt'); dt.textContent = label; const dd = document.createElement('dd'); dd.textContent = value || 'No Response'; return [dt, dd]; }));
  }
  scrollTo(0, 0);
};
const problems = (index) => {
  const data = new FormData(form);
  const missing = [];
  if (index === 0) {
    if (!held.source.length) missing.push('How Did You Hear About Us?');
    for (const [name, label] of [['given', 'Given Name'], ['family', 'Family Name'], ['email', 'Email'], ['phone', 'Phone Number']]) if (!String(data.get(name) ?? '').trim()) missing.push(label);
    if (!held.phoneCode.length) missing.push('Country Phone Code');
  }
  if (index === 1) {
    if (!document.getElementById('resume').files.length) missing.push('Resume/CV');
    if (held.skills.length < 5) return ['Skills: add at least 5 skills; ' + held.skills.length + ' items selected.'];
  }
  if (index === 2) {
    if (!data.get('authorized')) missing.push('Are you legally authorized to work in the country of this role?');
    if (!String(data.get('notice') ?? '').trim()) missing.push('What is your notice period?');
  }
  if (index === 3) {
    if (!held.veteran.length) missing.push('Veteran Status');
    if (!document.getElementById('terms').checked) missing.push('I consent to the terms and conditions');
  }
  return missing.map((label) => 'The field ' + label + ' is required and must have a value.');
};
document.getElementById('next').addEventListener('click', () => {
  const found = problems(current);
  const errors = document.getElementById('errors');
  errors.replaceChildren();
  if (found.length) {
    const box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.className = 'wd-errors';
    box.textContent = 'Errors Found\\n' + found.join('\\n');
    errors.append(box);
    return;
  }
  show(current + 1);
});
document.getElementById('back').addEventListener('click', () => show(current - 1));
show(0);
</script>`;

export async function handleWorkdayPrompts(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  if (url.pathname === "/workday-prompts/jobs/1") {
    send(
      200,
      `<!doctype html><title>Platform Engineer — Velvet Prompt</title><main><h1>Platform Engineer</h1><p>Velvet Prompt · Remote (EU) · Posted 2 days ago</p><p>Build product features end to end with React and TypeScript on Node.js services, PostgreSQL, Docker and AWS.</p><a href="/workday-prompts/apply/1">Apply</a></main>`,
    );
    return true;
  }
  if (url.pathname !== "/workday-prompts/apply/1") return false;
  if (req.method !== "POST") {
    send(200, page());
    return true;
  }
  const fields = await readPost(req);
  logPost(url.pathname, fields);
  const list = (name) => {
    try {
      const value = JSON.parse(fields[name] ?? "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const held = {
    source: list("source"),
    phoneCode: list("phoneCode"),
    skills: list("skills"),
    veteran: list("veteran"),
  };
  const problems = [
    held.source.length === 1 && sources.includes(held.source[0])
      ? null
      : "How Did You Hear About Us?",
    held.phoneCode.length === 1 && codes.includes(held.phoneCode[0])
      ? null
      : "Country Phone Code",
    held.skills.length >= 5 &&
    held.skills.every((item) => skills.includes(item))
      ? null
      : "Skills",
    held.veteran.length === 1 && veteran.includes(held.veteran[0])
      ? null
      : "Veteran Status",
    fields.terms === "yes" ? null : "Terms",
    fields.resume?.size > 0 ? null : "Resume/CV",
  ].filter(Boolean);
  send(
    problems.length ? 422 : 200,
    problems.length
      ? `<!doctype html><h1>Errors Found</h1><p>${problems.join(", ")}</p>`
      : `<!doctype html><title>Application Submitted</title><h1>Application Submitted</h1><p>Your application for Platform Engineer was submitted. Skills: ${held.skills.join(", ")}.</p>`,
  );
  return true;
}
