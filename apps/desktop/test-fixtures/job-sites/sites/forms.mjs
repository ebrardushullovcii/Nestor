import { countries, phoneCodes } from "./data.mjs";

export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const field = (name, label, type = "text", extra = {}) => ({
  name,
  label,
  type,
  required: true,
  ...extra,
});
export function fieldGroups(site) {
  const groups = [
    {
      label: "Contact details",
      fields: [
        field("name", "Full name"),
        field("email", "Email", "email"),
        ...(site.groups.includes("country")
          ? [
              field("country", "Country of residence", "combo", {
                options: countries,
              }),
              field("phoneCode", "Phone country code", "select", {
                options: phoneCodes,
              }),
            ]
          : []),
        field("phone", "Phone", "tel"),
      ],
    },
    {
      label: "Documents",
      fields: [
        field("resume", "Resume / CV", "file", {
          style: site.style,
          required: site.style !== "paste",
        }),
        ...(site.style === "paste"
          ? [
              field("resumeText", "Or paste your resume text", "textarea", {
                required: false,
                max: 12000,
              }),
            ]
          : []),
        ...(site.cover
          ? [field("coverLetterFile", "Cover letter upload", "file")]
          : []),
      ],
    },
  ];
  const optionalGroups = {
    links: {
      label: "Your work online",
      fields: [
        field("portfolio", "Portfolio URL", "url"),
        field("linkedin", "Professional profile URL", "url", {
          required: false,
        }),
        field("github", "Code profile URL", "url", { required: false }),
      ],
    },
    motivation: {
      label: "Your motivation",
      fields: [
        field("motivation", "Why would you like this role?", "rich", {
          max: 600,
        }),
      ],
    },
    questions: {
      label: "Eligibility questions",
      fields: [
        field(
          "authorized",
          "Are you authorized to work in the job's country?",
          "radio",
        ),
        field("sponsorship", "Will you need visa sponsorship?", "radio"),
        field("relocation", "Are you willing to relocate?", "radio"),
        field("over18", "Are you over 18?", "radio"),
      ],
    },
    dates: {
      label: "Availability",
      fields: [
        field("startDate", "Preferred start date", "date"),
        field("availability", "Interview availability date", "date"),
      ],
    },
    salary: {
      label: "Compensation",
      fields: [
        field("salary", "Annual salary expectation", "number", {
          min: 0,
          max: 10000000,
        }),
        field("currency", "Salary currency", "select", {
          options: ["USD", "GBP", "EUR"],
        }),
        field("notice", "Notice period", "select", {
          options: ["Immediate", "Two weeks", "One month", "Three months"],
        }),
      ],
    },
    skills: {
      label: "Skills",
      fields: [
        field("skills", "Select your skills", "multi", {
          options: ["Communication", "Analysis", "Planning", "Mentoring"],
        }),
        // Only the person knows this: Apply asks it in Needs you.
        field(
          "onsiteDays",
          "Which days could you work on site? Select all that apply",
          "multi",
          { options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
        ),
        field("analysisYears", "Years of analysis experience", "number", {
          min: 0,
          max: 60,
        }),
        field(
          "coordinationYears",
          "Years of coordination experience",
          "number",
          { min: 0, max: 60 },
        ),
      ],
    },
    diversity: {
      label: "Voluntary diversity / EEO (optional)",
      fields: [
        field("gender", "Gender", "select", {
          required: false,
          options: [
            "Woman",
            "Man",
            "Non-binary",
            "Self-describe",
            "Prefer not to say",
          ],
        }),
        field("disability", "Disability status", "select", {
          required: false,
          options: ["Yes", "No", "Prefer not to say"],
        }),
        field("veteran", "Veteran status", "select", {
          required: false,
          options: ["Veteran", "Not a veteran", "Prefer not to say"],
        }),
      ],
    },
    history: { label: "Work history (optional)", repeat: "work", fields: [] },
    education: {
      label: "Education (optional)",
      repeat: "education",
      fields: [],
    },
  };
  for (const name of site.groups)
    if (optionalGroups[name]) groups.push(optionalGroups[name]);
  groups.push({
    label: "Declarations",
    fields: [
      field("certify", "I certify that the information is true", "check"),
      field("privacy", "I acknowledge the privacy notice", "check"),
      field("backgroundConsent", "I consent to a background check", "check"),
      field("marketing", "Send me marketing updates (optional)", "check", {
        required: false,
      }),
    ],
  });
  return groups;
}
function errorMarkup(name, error) {
  return `<span class="error" id="error-${name}" data-error="${name}" role="alert">${escape(error)}</span>`;
}
function renderField(spec, values, errors) {
  const { name, label, type, required, options = [] } = spec;
  const value = typeof values[name] === "string" ? values[name] : "";
  const title = `${escape(label)}${required ? " *" : ""}`;
  const attributes = `name="${name}" id="${name}" aria-describedby="error-${name}" ${errors[name] ? 'aria-invalid="true"' : ""} ${required ? "required" : ""}`;
  const error = errorMarkup(name, errors[name]);
  if (type === "radio" || type === "multi") {
    const choices = type === "radio" ? ["Yes", "No"] : options;
    const selected = Array.isArray(values[name]) ? values[name] : [value];
    return `<fieldset class="choices"><legend>${title}</legend>${choices.map((choice, i) => `<label class="check"><input type="${type === "radio" ? "radio" : "checkbox"}" name="${name}" id="${name}-${i}" value="${escape(choice)}" aria-describedby="error-${name}" ${type === "radio" ? "required" : ""} ${selected.includes(choice) ? "checked" : ""}> ${escape(choice)}</label>`).join("")}${error}</fieldset>`;
  }
  if (type === "check")
    return `<label class="check"><input type="checkbox" ${attributes} value="yes" ${value === "yes" ? "checked" : ""}> ${title}</label>${error}`;
  if (type === "file") {
    const zone =
      spec.style === "drop"
        ? `<div class="drop-zone" data-drop="${name}" role="button" tabindex="0" aria-label="Drop ${escape(label)} or choose a file">Drop a document here or click to browse</div>`
        : "";
    return `<div class="upload"><label for="${name}">${title}</label>${zone}<input type="file" ${attributes} accept=".txt,.pdf,.doc,.docx"><span data-file-name="${name}" role="status">No file selected</span>${spec.style === "parse" ? '<button type="button" data-parse>Parse resume and prefill</button><p data-parse-status role="status">Simulated parsing; review the contact fields afterwards.</p>' : ""}${error}</div>`;
  }
  if (type === "combo")
    return `<div class="field combobox"><label for="country-search">${title}</label><input id="country-search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="country-options" autocomplete="off" value="${escape(value)}" required><input type="hidden" name="country" value="${escape(value)}"><ul id="country-options" role="listbox" hidden>${options.map((option, i) => `<li role="option" aria-selected="${value === option}" id="country-option-${i}" data-value="${escape(option)}">${escape(option)}</li>`).join("")}</ul>${error}</div>`;
  let control;
  if (type === "select")
    control = `<select ${attributes}><option value="">Select an option</option>${options.map((option) => `<option ${value === option ? "selected" : ""}>${escape(option)}</option>`).join("")}</select>`;
  else if (type === "textarea" || type === "rich")
    control = `${type === "rich" ? `<div class="formatting" role="group" aria-label="Answer formatting"><button type="button" data-format="**" data-target="${name}">Bold</button> <button type="button" data-format="_" data-target="${name}">Italic</button></div>` : ""}<textarea ${attributes} rows="5" maxlength="${spec.max}" data-counter="${name}">${escape(value)}</textarea><small data-count="${name}">${value.length} / ${spec.max} characters</small>`;
  else
    control = `<input type="${type}" ${attributes} value="${escape(value)}" ${spec.min !== undefined ? `min="${spec.min}" max="${spec.max}" step="1"` : ""}>`;
  return `<div class="field"><label for="${name}">${title}</label>${control}${error}</div>`;
}
export function applicationForm(site, job, values = {}, errors = {}) {
  const groups = fieldGroups(site);
  const stepCount = site.steps || 1;
  const steps = Array.from({ length: stepCount }, () => []);
  // Keep declarations on Review, documents early, and every group in its own step when possible.
  groups.forEach((group, index) => {
    const target =
      stepCount === 1
        ? 0
        : index === groups.length - 1
          ? stepCount - 1
          : Math.min(
              stepCount - 2,
              Math.floor((index * (stepCount - 1)) / (groups.length - 1)),
            );
    steps[target].push(group);
  });
  const content = steps
    .map(
      (stepGroups, step) =>
        `<fieldset data-step="${step}" ${step > 0 ? "hidden disabled" : ""}><legend>${stepCount === 1 ? "Application" : step === stepCount - 1 ? "Review and send" : `Step ${step + 1} of ${stepCount}: ${stepGroups[0]?.label || "Application"}`}</legend>${step === stepCount - 1 && stepCount > 1 ? "<p>Review your answers before sending.</p><div data-review></div>" : ""}${stepGroups.map((group) => `<section><h2>${escape(group.label)}</h2>${group.repeat ? `<p>Add an entry if applicable.</p><div data-rows="${group.repeat}"></div><button type="button" data-add="${group.repeat}">Add another ${group.repeat === "work" ? "work history" : "education"} entry</button>` : group.fields.map((spec) => renderField(spec, values, errors)).join("")}</section>`).join("")}${step > 0 ? '<button type="button" data-back>Back</button> ' : ""}${step < stepCount - 1 ? '<button type="button" data-next>Next</button>' : '<button type="submit">Send application</button>'}</fieldset>`,
    )
    .join("");
  return `<h1>Apply: ${escape(job.title)}</h1><p>${escape(job.company)} · ${escape(job.location)}</p><button type="button" data-profile>Apply with a profile from another site</button><p data-profile-note hidden role="status">This fictional profile service is unavailable. Use the application form below.</p>${site.timeout ? '<aside data-timeout hidden role="alert">Your session is about to time out. Your answers are still here. <button type="button" data-extend>Keep working</button></aside>' : ""}<form action="/${site.slug}/apply/${job.id}" method="post" enctype="multipart/form-data" data-application data-timeout-enabled="${Boolean(site.timeout)}" novalidate><p data-form-status role="alert">${Object.keys(errors).length ? "Please fix the marked fields below." : ""}</p>${stepCount > 1 ? `<ol class="stepper">${steps.map((_, i) => `<li data-step-label="${i}" ${i === 0 ? 'aria-current="step"' : ""}>${i + 1}. ${i === stepCount - 1 ? "Review" : steps[i][0]?.label || "Application"}</li>`).join("")}</ol>` : ""}${content}</form>`;
}
export function validateApplication(site, values) {
  const errors = {};
  for (const { fields } of fieldGroups(site))
    for (const spec of fields) {
      const value = values[spec.name];
      if (spec.type === "file") {
        if (spec.required && (!value?.filename || !(value.size > 0)))
          errors[spec.name] = `Please upload ${spec.label.toLowerCase()}.`;
        if (value?.size > 0 && !/\.(txt|pdf|docx?)$/i.test(value.filename))
          errors[spec.name] = "Use a TXT, PDF, DOC or DOCX file.";
        continue;
      }
      if (spec.type === "multi") {
        const selected =
          value === undefined ? [] : Array.isArray(value) ? value : [value];
        if (
          !selected.length ||
          selected.some((choice) => !spec.options.includes(choice))
        )
          errors[spec.name] =
            spec.name === "skills"
              ? "Select at least one listed skill."
              : "Select at least one listed option.";
        continue;
      }
      if (spec.required && (typeof value !== "string" || !value.trim())) {
        errors[spec.name] = `Please complete ${spec.label.toLowerCase()}.`;
        continue;
      }
      if (!value) continue;
      if (typeof value !== "string") {
        errors[spec.name] = "Enter one answer for this field.";
        continue;
      }
      if (spec.type === "check" && value !== "yes")
        errors[spec.name] = "Please tick this declaration.";
      if (spec.type === "radio" && !["Yes", "No"].includes(value))
        errors[spec.name] = "Choose Yes or No.";
      if (spec.options && !spec.options.includes(value))
        errors[spec.name] = "Choose an option from the list.";
      if (spec.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        errors[spec.name] = "Enter a valid email address.";
      if (spec.type === "tel" && !/^[+\d ()-]{6,30}$/.test(value))
        errors[spec.name] = "Enter a valid phone number.";
      if (spec.type === "url") {
        try {
          if (!["http:", "https:"].includes(new URL(value).protocol))
            throw new Error();
        } catch {
          errors[spec.name] = "Enter a complete http:// or https:// URL.";
        }
      }
      if (
        spec.type === "number" &&
        (!Number.isFinite(Number(value)) ||
          !Number.isInteger(Number(value)) ||
          Number(value) < spec.min ||
          Number(value) > spec.max)
      )
        errors[spec.name] =
          `Enter a whole number from ${spec.min} to ${spec.max}.`;
      if (
        spec.type === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value)
      )
        errors[spec.name] = "Enter a valid calendar date.";
      if (
        spec.max &&
        (spec.type === "rich" || spec.type === "textarea") &&
        value.length > spec.max
      )
        errors[spec.name] = `Keep your answer within ${spec.max} characters.`;
    }
  if (
    site.style === "paste" &&
    (!values.resume?.filename || !(values.resume.size > 0)) &&
    (typeof values.resumeText !== "string" ||
      values.resumeText.trim().length < 20)
  )
    errors.resumeText =
      "Upload a resume or paste at least 20 characters of resume text.";
  for (const name of Object.keys(values)) {
    const match =
      /^(work|education)(\d+)(Title|Company|From|To|Institution|Qualification|Year)$/.exec(
        name,
      );
    if (!match) continue;
    const [, kind, index] = match;
    const required =
      kind === "work"
        ? ["Title", "Company", "From"]
        : ["Institution", "Qualification", "Year"];
    for (const suffix of required) {
      const key = `${kind}${index}${suffix}`;
      if (typeof values[key] !== "string" || !values[key].trim())
        errors[key] = "Complete this entry or remove it.";
    }
    const from = values[`work${index}From`],
      to = values[`work${index}To`];
    if (kind === "work") {
      for (const suffix of ["From", "To"])
        if (
          values[`work${index}${suffix}`] &&
          !/^\d{4}-(0[1-9]|1[0-2])$/.test(values[`work${index}${suffix}`])
        )
          errors[`work${index}${suffix}`] = "Enter a valid month.";
      if (from && to && to < from)
        errors[`work${index}To`] = "End month must follow start month.";
    } else if (
      values[`education${index}Year`] &&
      !/^(19|20|21)\d{2}$/.test(values[`education${index}Year`])
    )
      errors[`education${index}Year`] =
        "Enter a four-digit year from 1900 to 2199.";
  }
  return errors;
}
