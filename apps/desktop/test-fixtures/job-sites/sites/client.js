// Browser behavior for the new fixtures only; every request stays same-origin.
const site = document.body.dataset.replica;
const banner = document.querySelector("[data-cookie-banner]");
if (banner) {
  const key = `replica-cookie-${site}`;
  banner.hidden = Boolean(sessionStorage.getItem(key));
  for (const button of banner.querySelectorAll("[data-cookie]"))
    button.addEventListener("click", () => {
      sessionStorage.setItem(key, button.dataset.cookie);
      banner.hidden = true;
    });
}

const loadMore = document.querySelector("[data-load-more]");
if (loadMore)
  loadMore.addEventListener("click", async (event) => {
    event.preventDefault();
    if (loadMore.getAttribute("aria-disabled") === "true") return;
    const status = document.querySelector("[data-load-status]");
    loadMore.setAttribute("aria-disabled", "true");
    status.textContent = "Loading more jobs…";
    try {
      const response = await fetch(loadMore.href);
      if (!response.ok)
        throw new Error(
          `Could not load jobs (${response.status}). Try again shortly.`,
        );
      const next = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const cards = next.querySelectorAll("#jobs .job");
      document.getElementById("jobs").append(...cards);
      const link = next.querySelector("[data-load-more]");
      if (link) loadMore.href = link.getAttribute("href");
      else loadMore.hidden = true;
      status.textContent = `${cards.length} more jobs loaded.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      loadMore.setAttribute("aria-disabled", "false");
    }
  });

const form = document.querySelector("[data-application]");
if (form) {
  const steps = [...form.querySelectorAll("[data-step]")];
  const status = form.querySelector("[data-form-status]");
  let current = 0;
  let submitting = false;
  function control(name) {
    return name === "country"
      ? document.getElementById("country-search")
      : form.querySelector(`[name="${name}"]`);
  }
  function clearErrors() {
    for (const error of form.querySelectorAll("[data-error]"))
      error.textContent = "";
    for (const input of form.querySelectorAll("[aria-invalid]"))
      input.removeAttribute("aria-invalid");
  }
  function showErrors(errors) {
    for (const [name, message] of Object.entries(errors)) {
      const error = form.querySelector(`[data-error="${name}"]`);
      if (error) error.textContent = message;
      control(name)?.setAttribute("aria-invalid", "true");
    }
    const first = control(Object.keys(errors)[0]);
    if (first) {
      const step = steps.findIndex((entry) => entry.contains(first));
      if (step >= 0) showStep(step);
      first.focus();
    }
    status.textContent = "Please fix the marked fields below.";
  }
  function collect() {
    steps.forEach((step) => {
      step.disabled = false;
    });
    const data = new FormData(form);
    steps.forEach((step, index) => {
      step.disabled = index !== current;
    });
    return data;
  }
  function review() {
    const summary = form.querySelector("[data-review]");
    if (!summary) return;
    const list = document.createElement("dl");
    for (const [name, value] of collect()) {
      if (!value || (value instanceof File && !value.size)) continue;
      const input = control(name);
      const term = document.createElement("dt");
      term.textContent =
        input?.closest(".choices")?.querySelector("legend")?.textContent ||
        input?.labels?.[0]?.textContent.trim() ||
        name;
      const description = document.createElement("dd");
      description.textContent = value instanceof File ? value.name : value;
      list.append(term, description);
    }
    summary.replaceChildren(list);
  }
  function showStep(index) {
    current = index;
    steps.forEach((step, i) => {
      step.hidden = i !== current;
      step.disabled = i !== current;
    });
    form.querySelectorAll("[data-step-label]").forEach((label, i) => {
      if (i === current) label.setAttribute("aria-current", "step");
      else label.removeAttribute("aria-current");
    });
    if (current === steps.length - 1 && steps.length > 1) review();
  }
  function validateStep(step) {
    const errors = {};
    for (const input of step.querySelectorAll("input, select, textarea")) {
      if (input.type === "hidden") continue;
      input.setCustomValidity("");
      if (!input.checkValidity())
        errors[input.id === "country-search" ? "country" : input.name] =
          input.validationMessage;
    }
    const skills = [...step.querySelectorAll('[name="skills"]')];
    if (skills.length && !skills.some((input) => input.checked))
      errors.skills = "Select at least one skill.";
    if (step.contains(control("country"))) {
      const search = document.getElementById("country-search");
      if (
        ![...document.querySelectorAll("[data-value]")].some(
          (option) => option.dataset.value === search.value,
        )
      )
        errors.country = "Choose a country from the list.";
    }
    const text = control("resumeText");
    const resume = control("resume");
    if (
      text &&
      step.contains(text) &&
      !resume.files.length &&
      text.value.trim().length < 20
    )
      errors.resumeText = "Upload a resume or paste at least 20 characters.";
    for (const input of step.querySelectorAll('input[type="file"]'))
      if (
        input.files.length &&
        (!input.files[0].size ||
          !/\.(txt|pdf|docx?)$/i.test(input.files[0].name))
      )
        errors[input.name] = "Upload a nonempty TXT, PDF, DOC or DOCX file.";
    return errors;
  }
  for (const button of form.querySelectorAll("[data-next]"))
    button.addEventListener("click", () => {
      clearErrors();
      const errors = validateStep(steps[current]);
      if (Object.keys(errors).length) showErrors(errors);
      else {
        status.textContent = "";
        showStep(current + 1);
        form.scrollIntoView({ block: "start" });
      }
    });
  for (const button of form.querySelectorAll("[data-back]"))
    button.addEventListener("click", () => {
      status.textContent = "";
      showStep(current - 1);
    });
  form.addEventListener("input", (event) => {
    const input = event.target;
    if (!input.name) return;
    input.removeAttribute("aria-invalid");
    input.setCustomValidity?.("");
    const error = form.querySelector(`[data-error="${input.name}"]`);
    if (error) error.textContent = "";
  });

  const countrySearch = document.getElementById("country-search");
  if (countrySearch) {
    const list = document.getElementById("country-options");
    const options = [...list.querySelectorAll("[role=option]")];
    const hidden = form.querySelector('[name="country"]');
    let active = -1;
    function select(option) {
      countrySearch.value = hidden.value = option.dataset.value;
      options.forEach((entry) =>
        entry.setAttribute("aria-selected", String(entry === option)),
      );
      list.hidden = true;
      countrySearch.setAttribute("aria-expanded", "false");
      countrySearch.removeAttribute("aria-activedescendant");
      countrySearch.dispatchEvent(new Event("input", { bubbles: true }));
      list.hidden = true;
      countrySearch.setAttribute("aria-expanded", "false");
      countrySearch.focus();
    }
    function filter() {
      const query = countrySearch.value.toLowerCase();
      options.forEach((option) => {
        option.hidden = !option.dataset.value.toLowerCase().includes(query);
      });
      hidden.value =
        options.find((option) => option.dataset.value === countrySearch.value)
          ?.dataset.value || "";
      list.hidden = false;
      countrySearch.setAttribute("aria-expanded", "true");
      active = -1;
    }
    countrySearch.addEventListener("focus", filter);
    countrySearch.addEventListener("input", filter);
    countrySearch.addEventListener("keydown", (event) => {
      const visible = options.filter((option) => !option.hidden);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        list.hidden = false;
        countrySearch.setAttribute("aria-expanded", "true");
        active = visible.length
          ? (active + (event.key === "ArrowDown" ? 1 : -1) + visible.length) %
            visible.length
          : -1;
        options.forEach((option) => option.classList.remove("active"));
        if (visible[active]) {
          visible[active].classList.add("active");
          countrySearch.setAttribute(
            "aria-activedescendant",
            visible[active].id,
          );
        }
      } else if (event.key === "Enter" && !list.hidden && visible.length) {
        event.preventDefault();
        select(visible[Math.max(active, 0)]);
      } else if (event.key === "Escape") {
        list.hidden = true;
        countrySearch.setAttribute("aria-expanded", "false");
      }
    });
    options.forEach((option) =>
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        select(option);
      }),
    );
    countrySearch.addEventListener("blur", () => {
      list.hidden = true;
      countrySearch.setAttribute("aria-expanded", "false");
    });
  }

  for (const input of form.querySelectorAll('input[type="file"]'))
    input.addEventListener("change", async () => {
      const label = form.querySelector(`[data-file-name="${input.name}"]`);
      label.textContent = input.files[0]?.name || "No file selected";
      if (new URLSearchParams(location.search).get("upload") !== "async")
        return;
      if (!input.files[0]) return;
      label.textContent = "Uploading resume…";
      const target = new URL("/replica-upload", location.href);
      target.hostname = "localhost";
      const body = new FormData();
      body.append(input.name, input.files[0]);
      try {
        const response = await fetch(target, { method: "POST", body });
        if (!response.ok || !(await response.json()).uploaded)
          throw new Error("Resume failed to upload");
        input.setCustomValidity("");
        label.textContent = `Resume attached: ${input.files[0].name}`;
      } catch {
        input.setCustomValidity("Resume failed to upload");
        label.textContent = "Resume failed to upload";
      }
    });
  for (const zone of form.querySelectorAll("[data-drop]")) {
    const input = control(zone.dataset.drop);
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        input.click();
      }
    });
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
      if (event.dataTransfer.files.length) {
        input.files = event.dataTransfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }
  const parse = form.querySelector("[data-parse]");
  if (parse)
    parse.addEventListener("click", async () => {
      const file = control("resume").files[0];
      const parseStatus = form.querySelector("[data-parse-status]");
      if (!file) {
        parseStatus.textContent = "Choose a resume first.";
        return;
      }
      parse.disabled = true;
      parseStatus.textContent = "Parsing your resume…";
      try {
        const text = /\.txt$/i.test(file.name) ? await file.text() : "";
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const values = {
          name: /^Name:\s*(.+)$/im.exec(text)?.[1] || "Fixture Candidate",
          email:
            /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.exec(text)?.[0] ||
            "prefill@example.invalid",
          phone: /^Phone:\s*(.+)$/im.exec(text)?.[1] || "000-000-0000",
        };
        for (const [name, value] of Object.entries(values))
          if (!control(name).value) control(name).value = value;
        parseStatus.textContent =
          "Simulated parsing complete. Contact details filled where blank. Review them on the contact step.";
      } catch {
        parseStatus.textContent =
          "Could not parse this document. Enter your contact details manually.";
      } finally {
        parse.disabled = false;
      }
    });
  for (const textarea of form.querySelectorAll("[data-counter]"))
    textarea.addEventListener("input", () => {
      form.querySelector(`[data-count="${textarea.name}"]`).textContent =
        `${textarea.value.length} / ${textarea.maxLength} characters`;
    });
  for (const button of form.querySelectorAll("[data-format]"))
    button.addEventListener("click", () => {
      const text = control(button.dataset.target);
      const marker = button.dataset.format;
      const value = `${marker}${text.value.slice(text.selectionStart, text.selectionEnd)}${marker}`;
      if (
        text.value.length -
          (text.selectionEnd - text.selectionStart) +
          value.length >
        text.maxLength
      )
        return;
      text.setRangeText(
        value,
        text.selectionStart,
        text.selectionEnd,
        "select",
      );
      text.dispatchEvent(new Event("input", { bubbles: true }));
      text.focus();
    });

  const counts = { work: 0, education: 0 };
  for (const button of form.querySelectorAll("[data-add]"))
    button.addEventListener("click", () => {
      const kind = button.dataset.add,
        index = ++counts[kind];
      const fields =
        kind === "work"
          ? [
              ["Title", "Job title", "text"],
              ["Company", "Company", "text"],
              ["From", "From", "month"],
              ["To", "To (optional)", "month"],
            ]
          : [
              ["Institution", "Institution", "text"],
              ["Qualification", "Qualification", "text"],
              ["Year", "Graduation year", "number"],
            ];
      const row = document.createElement("fieldset");
      row.innerHTML = `<legend>${kind === "work" ? "Work history" : "Education"} ${index}</legend>${fields.map(([suffix, label, type]) => `<label class="field" for="${kind}${index}${suffix}">${label}<input id="${kind}${index}${suffix}" name="${kind}${index}${suffix}" type="${type}" ${suffix === "To" ? "" : "required"} ${suffix === "Year" ? 'min="1900" max="2199"' : ""} aria-describedby="error-${kind}${index}${suffix}"></label><span class="error" id="error-${kind}${index}${suffix}" data-error="${kind}${index}${suffix}" role="alert"></span>`).join("")}<button type="button">Remove entry</button>`;
      row.querySelector("button").addEventListener("click", () => row.remove());
      form.querySelector(`[data-rows="${kind}"]`).append(row);
    });

  document.querySelector("[data-profile]").addEventListener("click", () => {
    document.querySelector("[data-profile-note]").hidden = false;
  });
  let expiresAt = Infinity;
  if (form.dataset.timeoutEnabled === "true") {
    const warning = document.querySelector("[data-timeout]");
    let warningTimer;
    function extend() {
      expiresAt = Date.now() + 120000;
      warning.hidden = true;
      clearTimeout(warningTimer);
      warningTimer = setTimeout(() => {
        warning.hidden = false;
      }, 60000);
      status.textContent = "Session extended. Your answers are unchanged.";
    }
    document.querySelector("[data-extend]").addEventListener("click", extend);
    extend();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (steps.length > 1 && current !== steps.length - 1) {
      status.textContent = "Continue to the review step before sending.";
      return;
    }
    if (Date.now() > expiresAt) {
      status.textContent =
        "Your session timed out. Choose Keep working to extend it and send again.";
      document.querySelector("[data-timeout]").hidden = false;
      return;
    }
    clearErrors();
    steps.forEach((step) => {
      step.disabled = false;
    });
    const errors = Object.assign({}, ...steps.map(validateStep));
    const data = new FormData(form);
    steps.forEach((step, index) => {
      step.disabled = index !== current;
    });
    if (Object.keys(errors).length) {
      showErrors(errors);
      return;
    }
    submitting = true;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = "Sending application…";
    try {
      const response = await fetch(form.action, {
        method: "POST",
        body: data,
        headers: { Accept: "application/json" },
      });
      if (response.status === 429)
        throw new Error(
          `Please wait ${response.headers.get("Retry-After") || "a few"} seconds, then send again. Your application was not sent.`,
        );
      const result = await response.json();
      if (result.errors) {
        showErrors(result.errors);
        return;
      }
      if (!response.ok)
        throw new Error(
          "The application could not be sent. Your answers are still here.",
        );
      const receipt = document.createElement("section");
      const heading = document.createElement("h1");
      heading.setAttribute("role", "status");
      heading.textContent = result.message;
      const reference = document.createElement("p");
      reference.textContent = `Reference: ${result.reference}`;
      receipt.append(heading, reference);
      form.replaceWith(receipt);
      receipt.scrollIntoView();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submitting = false;
      button.disabled = false;
    }
  });
}
