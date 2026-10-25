// These pages deliberately use ordinary DOM controls and same-origin requests.
for (const button of document.querySelectorAll('[data-upload]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.upload).click());
}
for (const label of document.querySelectorAll('.upload-label')) {
  label.addEventListener('keydown', event => {
    if (event.target === label && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      document.getElementById(label.htmlFor).click();
    }
  });
}
for (const file of document.querySelectorAll('input[type="file"]')) {
  file.addEventListener('change', () => {
    document.querySelector(`[data-file-name="${file.name}"]`).textContent = file.files[0]?.name || 'No file selected';
  });
}
for (const zone of document.querySelectorAll('[data-drop]')) {
  const file = document.getElementById(zone.dataset.drop);
  zone.addEventListener('click', () => file.click());
  zone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); file.click(); }
  });
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', event => {
    event.preventDefault();
    zone.classList.remove('dragging');
    if (event.dataTransfer.files.length) {
      file.files = event.dataTransfer.files;
      file.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

const lever = document.querySelector('form[data-site="lever"]');
if (lever?.elements.human) lever.addEventListener('submit', event => {
  const error = document.getElementById('captcha-error');
  error.hidden = lever.elements.human.checked;
  if (!lever.elements.human.checked) event.preventDefault();
});

const cookieBanner = document.getElementById('cookie-banner');
if (cookieBanner) {
  cookieBanner.hidden = Boolean(sessionStorage.getItem('fixture-cookie-choice'));
  for (const button of cookieBanner.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      sessionStorage.setItem('fixture-cookie-choice', button.dataset.cookie);
      cookieBanner.hidden = true;
    });
  }
  const chat = document.getElementById('chat-panel');
  const toggle = document.getElementById('chat-toggle');
  toggle.addEventListener('click', () => { chat.hidden = !chat.hidden; toggle.setAttribute('aria-expanded', String(!chat.hidden)); });
  document.getElementById('chat-close').addEventListener('click', () => { chat.hidden = true; toggle.setAttribute('aria-expanded', 'false'); });
}

const gatekeeper = document.querySelector('form[data-site="gatekeeper"]');
if (gatekeeper) {
  let pendingSaves = Promise.resolve();
  const saveField = event => {
    const field = event.target;
    if (!field.name) return;
    const value = field.type === 'file' ? Array.from(field.files, file => ({ filename: file.name, size: file.size })) : field.value;
    const payload = { jobId: gatekeeper.elements.jobId.value, field: field.name, value };
    const status = document.getElementById('autosave-status');
    status.textContent = 'Saving…';
    pendingSaves = pendingSaves.then(async () => {
      const response = await fetch('/gatekeeper/api/autosave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error('Save failed');
      status.textContent = 'Saved';
    }).catch(() => { status.textContent = 'Could not save this answer. Edit it to try again.'; });
  };
  gatekeeper.addEventListener('input', saveField);
  gatekeeper.addEventListener('change', event => { if (event.target.type === 'file') saveField(event); });
  gatekeeper.addEventListener('submit', async event => {
    event.preventDefault();
    const button = gatekeeper.querySelector('button[type="submit"], button:not([type])');
    button.disabled = true;
    try {
      await pendingSaves;
      const response = await fetch('/gatekeeper/api/submit', { method: 'POST', body: new FormData(gatekeeper) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const message = document.createElement('h1');
      message.setAttribute('role', 'status');
      message.textContent = result.message;
      gatekeeper.replaceWith(message);
    } catch (error) {
      document.getElementById('submit-error').textContent = error.message;
      button.disabled = false;
    }
  });
}

const workday = document.getElementById('workday-form');
if (workday) {
  const steps = Array.from(workday.querySelectorAll('[data-step]'));
  const status = document.getElementById('workday-status');
  let current = 0;
  let experienceCount = 0;
  const addExperience = () => {
    const index = ++experienceCount;
    const block = document.createElement('fieldset');
    block.innerHTML = `<legend>Work experience ${index}</legend><label class="field">Job title<input name="experience${index}Title" required></label><label class="field">Company<input name="experience${index}Company" required></label><label class="field">From<input name="experience${index}From" type="month" required></label><label class="field">To (optional)<input name="experience${index}To" type="month"></label><label class="field">Description<textarea name="experience${index}Description"></textarea></label><button type="button">Remove</button>`;
    block.querySelector('button').addEventListener('click', () => block.remove());
    document.getElementById('experience-blocks').append(block);
  };
  document.getElementById('add-experience').addEventListener('click', addExperience);
  addExperience();
  const collect = () => {
    steps.forEach(step => { step.disabled = false; });
    const data = new FormData(workday);
    steps.forEach((step, index) => { step.disabled = index !== current; });
    return data;
  };
  const review = () => {
    const summary = document.getElementById('review-summary');
    summary.replaceChildren();
    const list = document.createElement('dl');
    for (const [name, value] of collect()) {
      if (name === 'jobId' || name === 'terms' || value === '') continue;
      const term = document.createElement('dt');
      const field = workday.elements.namedItem(name);
      const control = field instanceof RadioNodeList ? field[0] : field;
      term.textContent = control.closest('fieldset')?.querySelector('legend')?.textContent && control.type === 'radio'
        ? control.closest('fieldset').querySelector('legend').textContent
        : control.labels?.[0]?.firstChild?.textContent || name.replace(/([A-Z])/g, ' $1');
      const definition = document.createElement('dd');
      definition.textContent = value instanceof File ? value.name || 'No file selected' : value;
      list.append(term, definition);
    }
    summary.append(list);
  };
  const showStep = index => {
    current = index;
    steps.forEach((step, stepIndex) => { step.hidden = stepIndex !== index; step.disabled = stepIndex !== index; });
    workday.querySelectorAll('[data-step-label]').forEach((label, labelIndex) => {
      if (labelIndex === index) label.setAttribute('aria-current', 'step');
      else label.removeAttribute('aria-current');
    });
    if (index === 3) review();
    status.textContent = '';
    window.scrollTo(0, 0);
  };
  const save = async () => {
    status.textContent = 'Saving…';
    const response = await fetch('/workday/api/save', { method: 'POST', body: collect() });
    if (!response.ok) throw new Error('Could not save. Please try again.');
    status.textContent = 'Saved';
  };
  for (const button of workday.querySelectorAll('[data-next], [data-save-review]')) {
    button.addEventListener('click', async () => {
      if (!workday.reportValidity()) return;
      button.disabled = true;
      try { await save(); if (current < 3) showStep(current + 1); }
      catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
  }
  for (const button of workday.querySelectorAll('[data-back]')) button.addEventListener('click', () => showStep(current - 1));
  workday.addEventListener('submit', event => {
    if (current !== 3) { event.preventDefault(); return; }
    steps.forEach(step => { step.disabled = false; });
    const invalidIndex = steps.findIndex(step => Array.from(step.querySelectorAll('input, select, textarea')).some(field => !field.checkValidity()));
    if (invalidIndex !== -1) { event.preventDefault(); showStep(invalidIndex); workday.reportValidity(); }
  });
  workday.querySelector('[data-autofill]').addEventListener('click', event => {
    const button = event.currentTarget;
    button.disabled = true;
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-label', 'Loading');
    button.append(' ', spinner);
    setTimeout(() => { spinner.remove(); button.disabled = false; }, 1500);
  });
}
