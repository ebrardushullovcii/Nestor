// Two résumé widgets in the shapes real boards use, read from their public
// client code and the requests their pages make (October 2026). Both hand
// the file to S3-style storage on another origin; here that origin is
// `localhost` on this same server, while the form is on 127.0.0.1. Storage
// accepts every upload, so whatever stops one is on Nestor's side.
//
// Ashby keeps the form on its server, and its monitoring wraps fetch once
// the page has loaded. Every GraphQL call goes to
// `/api/non-user-graphql?op=<operation>`. Each answer is saved as it is
// entered with ApiSetFormValue. A file asks ApiCreateFileUploadHandle for a
// handle, posts `Content-Type`, the signing fields and the file to the
// handle's storage URL with fetch, and then binds the stored file to the
// field with ApiSetFormValueToFile carrying that handle. Submit sends only
// the form's identifiers: the server submits what it saved, and refuses when
// a required answer was never saved. A failed upload or bind shows a toast
// and clears the file.
//
// Greenhouse: a GET to the presign host hands out the signing fields and a
// key template: `x-amz-server-side-encryption`, `success_action_status: 201`
// and a policy that also names the form's `utf8` and `authenticity_token`.
// The page removes the file input, then sends `utf8`, the signing fields,
// the key, `authenticity_token`, `Content-Type: application/octet-stream`
// and the file with XMLHttpRequest. Storage answers 201 with an XML receipt;
// the name shows only once the upload progress reached 100%.
// A failed send only logs to the console.
//
// Workable: a GET on the form's own site
// (`/api/v1/jobs/<code>/form/upload/resume`) hands out the storage URL and
// its fields: an empty `utf8`, the bucket, the signing fields, the key and
// a policy. The page sends `Content-Type` (the file's own type), each field
// in that order, then the file, with XMLHttpRequest. Storage answers 204.
// A failed upload shows an error under the field and clears it.
//
// A contact-only role form (Askable's shape): Name, Email, Phone and one
// required consent box in a form with no method or action of its own. Its
// Apply button submits the form; the page's handler stops the native submit,
// checks the fields, and posts them as JSON with fetch to the site's own
// route. Only once that answers ok does it go on to the thank-you page.
//
// Lever: the résumé input posts the file, renamed with spaces and other
// punctuation turned into underscores, and the form's public `accountId` to
// `/parseResume` with XMLHttpRequest. The answer fills the fields the person
// has not touched (a change or paste marks one touched) and the hidden
// `resumeStorageId`; the page shows "Success!" or that it could not read the
// file. The final submit posts the whole form.

const s3Signing = {
  "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
  "X-Amz-Credential":
    "EXAMPLEUPLOADKEY12345/20990101/local-test-1/s3/aws4_request",
  "X-Amz-Date": "20990101T000000Z",
};
const securityToken = "c3ludGhldGljLXVwbG9hZC1zZXNzaW9uLXRva2Vu";
const ashbyPolicy = Buffer.from(
  JSON.stringify({
    expiration: "2099-01-01T01:00:00Z",
    conditions: [
      { acl: "private" },
      { bucket: "synthetic-ashby-files" },
      ["starts-with", "$key", "uploads/"],
      ["starts-with", "$Content-Type", ""],
      ["content-length-range", 0, 104857600],
      { "x-amz-algorithm": s3Signing["X-Amz-Algorithm"] },
      { "x-amz-credential": s3Signing["X-Amz-Credential"] },
      { "x-amz-date": s3Signing["X-Amz-Date"] },
      { "x-amz-security-token": securityToken },
    ],
  }),
).toString("base64");
const greenhousePolicy = Buffer.from(
  JSON.stringify({
    expiration: "2099-01-01T01:00:00Z",
    conditions: [
      { bucket: "synthetic-greenhouse-files" },
      ["starts-with", "$utf8", ""],
      ["starts-with", "$authenticity_token", ""],
      ["starts-with", "$key", "uploads/"],
      { "x-amz-server-side-encryption": "AES256" },
      { success_action_status: "201" },
      ["content-length-range", 1, 104857600],
      ["starts-with", "$Content-Type", ""],
      { "x-amz-credential": s3Signing["X-Amz-Credential"] },
      { "x-amz-algorithm": s3Signing["X-Amz-Algorithm"] },
      { "x-amz-date": s3Signing["X-Amz-Date"] },
    ],
  }),
).toString("base64");

const workableKey =
  "tmp/ttl-1d/production/0a1b2c3d-4e5f-4789-8bcd-ef0123456789";
const workablePolicy = Buffer.from(
  JSON.stringify({
    expiration: "2099-01-01T01:00:00Z",
    conditions: [
      ["starts-with", "$utf8", ""],
      ["eq", "$key", workableKey],
      ["content-length-range", 1, 12000000],
      ["starts-with", "$Content-Type", ""],
      { utf8: "" },
      { bucket: "synthetic-workable-files" },
      { "X-Amz-Algorithm": s3Signing["X-Amz-Algorithm"] },
      { "X-Amz-Credential": s3Signing["X-Amz-Credential"] },
      { "X-Amz-Date": s3Signing["X-Amz-Date"] },
      { key: workableKey },
    ],
  }),
).toString("base64");

// The operations as Ashby's client sends them (its public bundle).
const ashbyQueries = {
  ApiAutocompleteGeoLocation:
    "query ApiAutocompleteGeoLocation($text: String!, $locationTypes: [GeoLocationType!]) {\n  result: autocompleteGeoLocation(text: $text, locationTypes: $locationTypes) {\n    ...AutocompleteLocationResultParts\n    __typename\n  }\n}\n\nfragment AutocompleteGeoLocationParts on GeoLocation {\n  name\n  type\n  providerLocationId\n  __typename\n}\n\nfragment AutocompleteLocationParts on AutocompleteLocation {\n  name\n  geoLocationPath {\n    ...AutocompleteGeoLocationParts\n    __typename\n  }\n  __typename\n}\n\nfragment AutocompleteLocationResultParts on AutocompleteLocationResult {\n  suggestions {\n    ...AutocompleteLocationParts\n    __typename\n  }\n  __typename\n}",
  ApiCreateFileUploadHandle:
    "mutation ApiCreateFileUploadHandle($organizationHostedJobsPageName: String!, $fileUploadContext: FileUploadContext!, $filename: String!, $contentType: String!, $contentLength: Int!) {\n  fileUploadHandle: createFileUploadHandle(organizationHostedJobsPageName: $organizationHostedJobsPageName, fileUploadContext: $fileUploadContext, filename: $filename, contentType: $contentType, contentLength: $contentLength) {\n    handle\n    url\n    fields\n    __typename\n  }\n}",
  ApiSetFormValueToFile:
    "mutation ApiSetFormValueToFile($organizationHostedJobsPageName: String!, $formRenderIdentifier: String!, $path: String!, $fileHandle: String, $formDefinitionIdentifier: String) {\n  setFormValueToFile(organizationHostedJobsPageName: $organizationHostedJobsPageName, formRenderIdentifier: $formRenderIdentifier, path: $path, fileHandle: $fileHandle, formDefinitionIdentifier: $formDefinitionIdentifier) {\n    id\n    __typename\n  }\n}",
  ApiSetFormValue:
    "mutation ApiSetFormValue($organizationHostedJobsPageName: String!, $formRenderIdentifier: String!, $path: String!, $value: JSON, $formDefinitionIdentifier: String) {\n  setFormValue(organizationHostedJobsPageName: $organizationHostedJobsPageName, formRenderIdentifier: $formRenderIdentifier, path: $path, value: $value, formDefinitionIdentifier: $formDefinitionIdentifier) {\n    id\n    __typename\n  }\n}",
  ApiSubmitSingleApplicationFormAction:
    "mutation ApiSubmitSingleApplicationFormAction($organizationHostedJobsPageName: String!, $jobPostingId: String!, $formRenderIdentifier: String!, $formDefinitionIdentifier: String, $actionIdentifier: String!) {\n  submitApplicationFormAction: submitSingleApplicationFormAction(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId, formRenderIdentifier: $formRenderIdentifier, formDefinitionIdentifier: $formDefinitionIdentifier, actionIdentifier: $actionIdentifier) {\n    ok\n    missing\n    __typename\n  }\n}",
};

/**
 * Ashby's Yes/No input, as its page renders it: two buttons with no type,
 * `aria-pressed` and `data-option`, and a hidden checkbox, inside the
 * question's field. Its label points at no element, and marks the question
 * required only with a class (the asterisk is drawn by CSS).
 */
const ashbyYesNo = (path, question) => `
      <div class="field-entry"><label class="_required_f7cvd_91 ashby-application-form-question-title" for="${path}-field">${question}</label>
        <div data-yesno="${path}">
          <button aria-pressed="false" data-option="yes">Yes</button>
          <button aria-pressed="false" data-option="no">No</button>
          <input type="checkbox" tabindex="-1" name="${path}" style="position:absolute;opacity:0;pointer-events:none">
        </div></div>`;

/**
 * Ashby's location question: an autocomplete with no `required` and no id
 * its label could point at. Only the title's class says it is required.
 * What is typed is searched with the GraphQL query
 * ApiAutocompleteGeoLocation (its name and fragments say "Autocomplete");
 * the results show in a floating listbox the input does not point at, with
 * "No results" while it is empty. A pick fills the input and is saved;
 * leaving without one clears what was typed. Putting the same text in again
 * is no change to it, so a box that already shows a pick searches nothing.
 */
/**
 * Ashby's date question, a react-datepicker: a text box ("Pick date...")
 * whose calendar opens beside it, a month header and weekday letters, days
 * named "Choose Tuesday, October 27th, 2026", and Previous and Next Month
 * buttons. A pick fills the box as MM/DD/YYYY; typed words stay as typed.
 */
const ashbyStartDate = `
      <div class="field-entry"><label class="ashby-application-form-question-title" for="start">When could you start?</label>
        <div class="react-datepicker-wrapper"><div class="react-datepicker__input-container">
          <input type="text" placeholder="Pick date..." class="ashby-application-form-input-date" value="" id="start-input">
        </div></div>
        <div class="react-datepicker-popper" id="start-popper" hidden></div></div>`;

const ashbyLocation = `
      <div class="field-entry"><label class="_required_f7cvd_91 ashby-application-form-question-title" for="_systemfield_location">What country are you based in?</label>
        <div><p>This should be the location you're physically located</p></div>
        <div><input placeholder="Start typing..." aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" role="combobox" value="" id="location-input"></div></div>`;

/** Ashby's form state, kept by the server per rendered form. */
const ashbyForms = new Map();
const ashbyFields = [
  { path: "_systemfield_name", label: "Name", required: true },
  { path: "_systemfield_email", label: "Email", required: true },
  { path: "_systemfield_resume", label: "Resume", required: true },
  { path: "adult", label: "Are you over the age of 18?", required: true },
  {
    path: "timezone",
    label: "Are you based in a EU or equivalent timezone?",
    required: true,
  },
  {
    path: "_systemfield_location",
    label: "What country are you based in?",
    required: true,
  },
];

const sites = {
  "ashby-shape": {
    title: "Product Engineer",
    company: "Hosted Board Replica",
    form: () => `
      <p><label for="_systemfield_name">Name *</label><input id="_systemfield_name" required></p>
      <p><label for="_systemfield_email">Email *</label><input id="_systemfield_email" type="email" required></p>
      <div><label for="_systemfield_resume">Resume *</label>
        <button type="button" onclick="document.getElementById('_systemfield_resume').click()">Upload File</button>
        <input id="_systemfield_resume" type="file" accept=".pdf" style="display:none">
        <span id="chip"></span></div>
      ${ashbyYesNo("adult", "Are you over the age of 18?")}
      ${ashbyYesNo("timezone", "Are you based in a EU or equivalent timezone?")}
      ${ashbyLocation}
      ${ashbyStartDate}`,
    script: `
      // Ashby's monitoring wraps fetch once the page has loaded, after
      // anything installed before the page's own scripts.
      addEventListener('load', () => {
        const unwrapped = window.fetch;
        window.fetch = function () { return unwrapped.apply(this, arguments); };
      });
      const render = 'render-' + Math.random().toString(36).slice(2, 10);
      document.getElementById('application').dataset.render = render;
      const toast = (text) => { document.getElementById('toast').textContent = text; };
      const queries = ${JSON.stringify(ashbyQueries)};
      const graphql = async (operationName, variables) => {
        const response = await fetch('/ashby-shape/api/non-user-graphql?op=' + encodeURIComponent(operationName), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationName, variables: { organizationHostedJobsPageName: 'replica', ...variables }, query: queries[operationName] }),
        });
        const body = await response.json();
        if (!response.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? 'Request failed');
        return body.data;
      };
      // Ashby's Yes/No: pressing the pressed option again clears the answer;
      // each change is saved like any other answer.
      for (const box of document.querySelectorAll('[data-yesno]')) {
        const [yes, no] = box.querySelectorAll('button');
        const hidden = box.querySelector('input');
        let value;
        const show = () => {
          yes.setAttribute('aria-pressed', String(value === true));
          no.setAttribute('aria-pressed', String(value === false));
          hidden.checked = value === true;
          graphql('ApiSetFormValue', { formRenderIdentifier: render, path: box.dataset.yesno, value: value ?? null }).catch(() => toast('Your answer could not be saved.'));
        };
        yes.addEventListener('click', () => { value = value !== true || undefined; show(); });
        no.addEventListener('click', () => { value = value === false ? undefined : false; show(); });
      }
      // The start date's calendar, drawn beside the box while it is open.
      const start = document.getElementById('start-input');
      const popper = document.getElementById('start-popper');
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const ordinal = (day) => day + (day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th');
      let shownMonth = new Date(2026, 9, 1);
      const drawCalendar = () => {
        const year = shownMonth.getFullYear();
        const month = shownMonth.getMonth();
        const count = new Date(year, month + 1, 0).getDate();
        let days = '';
        for (let day = 1; day <= count; day += 1) {
          const weekday = weekdays[new Date(year, month, day).getDay()];
          days += '<div role="option" class="react-datepicker__day" aria-label="Choose ' + weekday + ', ' + months[month] + ' ' + ordinal(day) + ', ' + year + '" data-day="' + day + '">' + day + '</div>';
        }
        popper.innerHTML = '<div class="react-datepicker"><button type="button" aria-label="Previous Month">‹</button><button type="button" aria-label="Next Month">›</button>' +
          '<div class="react-datepicker__header"><div class="react-datepicker__current-month">' + months[month] + ' ' + year + '</div>' +
          '<div class="react-datepicker__day-names">SuMoTuWeThFrSa</div></div><div role="listbox" class="react-datepicker__month">' + days + '</div></div>';
        popper.querySelector('[aria-label="Previous Month"]').addEventListener('click', () => { shownMonth = new Date(year, month - 1, 1); drawCalendar(); });
        popper.querySelector('[aria-label="Next Month"]').addEventListener('click', () => { shownMonth = new Date(year, month + 1, 1); drawCalendar(); });
        for (const cell of popper.querySelectorAll('[role=option]'))
          cell.addEventListener('click', () => {
            const pad = (value) => String(value).padStart(2, '0');
            start.value = pad(month + 1) + '/' + pad(Number(cell.dataset.day)) + '/' + year;
            popper.hidden = true;
          });
      };
      start.addEventListener('focus', () => { drawCalendar(); popper.hidden = false; });
      start.addEventListener('click', () => { drawCalendar(); popper.hidden = false; });
      // The location list shows the countries matching what was typed; a
      // pick is saved like any other answer.
      const place = document.getElementById('location-input');
      const list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      list.hidden = true;
      document.body.append(list);
      let picked = '';
      let search;
      const draw = (names) => {
        list.innerHTML = names.length
          ? names.map((name) => '<div role="option">' + name + '</div>').join('')
          : '<div>No results</div>';
        for (const option of list.querySelectorAll('[role=option]'))
          option.addEventListener('mousedown', (event) => {
            event.preventDefault();
            picked = shown = place.value = option.textContent;
            list.hidden = true;
            place.setAttribute('aria-expanded', 'false');
            graphql('ApiSetFormValue', { formRenderIdentifier: render, path: '_systemfield_location', value: picked }).catch(() => toast('Your answer could not be saved.'));
          });
      };
      const open = () => {
        list.hidden = false;
        place.setAttribute('aria-expanded', 'true');
      };
      place.addEventListener('focus', () => { open(); draw([]); });
      // Like React's own value tracking: text put in again that equals what
      // the box already shows is no change, so nothing is searched.
      let shown = '';
      place.addEventListener('input', () => {
        if (place.value === shown) return;
        shown = place.value;
        open();
        clearTimeout(search);
        search = setTimeout(async () => {
          try {
            draw((await graphql('ApiAutocompleteGeoLocation', { text: place.value, locationTypes: ['Country'] })).result.suggestions.map((entry) => entry.name));
          } catch {
            draw([]);
          }
        }, 300);
      });
      place.addEventListener('blur', () => {
        list.hidden = true;
        place.setAttribute('aria-expanded', 'false');
        if (place.value !== picked) shown = place.value = '';
      });
      // Each answer is saved as it is entered, as Ashby does.
      for (const id of ['_systemfield_name', '_systemfield_email']) {
        const field = document.getElementById(id);
        let timer;
        const save = () => graphql('ApiSetFormValue', { formRenderIdentifier: render, path: id, value: field.value }).catch(() => toast('Your answer could not be saved.'));
        field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 500); });
        field.addEventListener('blur', () => { clearTimeout(timer); save(); });
      }
      const input = document.getElementById('_systemfield_resume');
      input.addEventListener('change', async () => {
        const file = input.files[0];
        const chip = document.getElementById('chip');
        chip.textContent = file.name;
        try {
          const handle = (await graphql('ApiCreateFileUploadHandle', { fileUploadContext: 'NonUserFormEngine', filename: file.name, contentType: file.type, contentLength: file.size })).fileUploadHandle;
          const body = new FormData();
          body.append('Content-Type', file.type);
          for (const [key, value] of Object.entries(handle.fields)) body.append(key, value);
          body.append('file', file);
          if (!(await fetch(handle.url, { method: 'POST', body })).ok) throw new Error('storage');
          await graphql('ApiSetFormValueToFile', { formRenderIdentifier: render, path: '_systemfield_resume', fileHandle: handle.handle });
          chip.dataset.upload = 'bound';
        } catch {
          chip.textContent = '';
          chip.dataset.upload = 'failed';
          toast(file.name + ' failed to upload');
        }
      });
      document.getElementById('send').addEventListener('click', async () => {
        try {
          const result = (await graphql('ApiSubmitSingleApplicationFormAction', { formRenderIdentifier: render, jobPostingId: 'replica-1', actionIdentifier: 'submit' })).submitApplicationFormAction;
          toast(result.ok ? 'Thank you! Your application has been received.' : 'Please complete: ' + result.missing.join(', '));
        } catch {
          toast('Submission failed.');
        }
      });`,
  },
  "greenhouse-shape": {
    title: "Platform Engineer",
    company: "Job Board Replica",
    form: () => `
      <p><label for="first_name">First Name *</label><input id="first_name" name="first_name" required></p>
      <p><label for="last_name">Last Name *</label><input id="last_name" name="last_name" required></p>
      <p><label for="email">Email *</label><input id="email" name="email" type="email" required><span id="email-error" role="alert"></span></p>
      <div><p id="resume-label">Resume/CV *</p>
        <label for="resume">Attach</label>
        <input id="resume" type="file" aria-describedby="resume-label" style="position:absolute;width:1px;height:1px;opacity:0">
        <span id="chip"></span><input type="hidden" name="resume_url" id="resume_url"></div>`,
    script: `
      // Greenhouse checks the typed email with a GET to a sibling host
      // (email-address-validator.us.greenhouse.io); here a sibling of the
      // page's host when it has one, else the page's own host.
      const email = document.getElementById('email');
      email.addEventListener('change', async () => {
        const host = location.hostname.split('.').length > 2
          ? location.host.replace(/^[^.]+/, 'email-address-validator')
          : location.host;
        let valid = false;
        try {
          valid = (await (await fetch(location.protocol + '//' + host + '/greenhouse-shape/address/validate?email=' + encodeURIComponent(email.value))).json()).valid;
        } catch {}
        email.setAttribute('aria-invalid', String(!valid));
        document.getElementById('email-error').textContent = valid ? '' : 'Please enter a valid email address.';
      });
      const input = document.getElementById('resume');
      input.addEventListener('change', async () => {
        const file = input.files[0];
        // The presign comes from another host, as on Greenhouse's boards.
        const presignHost = location.origin.replace('127.0.0.1', 'localhost');
        const signed = await (await fetch(presignHost + '/greenhouse-shape/uncacheable_attributes/presigned_fields?fields[]=resume')).json();
        const body = new FormData();
        body.append('utf8', '✓');
        for (const key in signed.resume.fields) body.append(key, signed.resume.fields[key]);
        const key = signed.resume.key
          .replace('{timestamp}', String(Date.now()))
          .replace('{unique_id}', Math.random().toString(36).slice(2, 16));
        body.append('key', key);
        body.append('authenticity_token', '1234');
        body.append('Content-Type', 'application/octet-stream');
        body.append('file', file);
        // Greenhouse removes the input once it has the file, shows progress,
        // and shows the file's name only when the upload reached 100% and
        // the storage answered 2xx.
        input.remove();
        const chip = document.getElementById('chip');
        chip.textContent = 'Uploading…';
        let progress = 0;
        const request = new XMLHttpRequest();
        request.onloadend = () => {
          if (request.status >= 200 && request.status < 300) {
            document.getElementById('resume_url').value = signed.url + '/' + key;
            if (progress >= 100) chip.textContent = file.name;
          } else console.error('Request failed');
        };
        // The progress listener also makes the POST preflighted.
        request.upload.onprogress = (event) => {
          progress = (event.loaded / event.total) * 100;
        };
        request.open('POST', signed.url);
        request.send(body);
      });`,
  },
};

sites["workable-shape"] = {
  title: "Senior Backend Developer",
  company: "Hosted Form Replica",
  form: () => `
      <p><label for="firstname">First name *</label><input id="firstname" name="firstname" required></p>
      <p><label for="lastname">Last name *</label><input id="lastname" name="lastname" required></p>
      <p><label for="email">Email *</label><input id="email" name="email" type="email" required></p>
      <div><label for="resume">Resume *</label>
        <input id="resume" type="file" accept=".pdf,.doc,.docx,.odt,.rtf">
        <span id="chip"></span><span id="resume-error" role="alert"></span>
        <input type="hidden" name="resume_path" id="resume_path"></div>`,
  script: `
      const input = document.getElementById('resume');
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const chip = document.getElementById('chip');
        const error = document.getElementById('resume-error');
        chip.textContent = 'Uploading…';
        error.textContent = '';
        const signed = (await (await fetch('/workable-shape/api/v1/jobs/1/form/upload/resume')).json()).uploadPostUrl;
        const body = new FormData();
        body.append('Content-Type', file.type);
        Object.keys(signed.fields).forEach((key) => body.append(key, signed.fields[key]));
        body.append('file', file);
        const request = new XMLHttpRequest();
        request.onloadend = () => {
          if (request.status >= 200 && request.status < 300) {
            document.getElementById('resume_path').value = signed.path;
            chip.textContent = file.name;
          } else {
            chip.textContent = '';
            error.textContent = 'Something went wrong while uploading your file.';
            input.value = '';
          }
        };
        request.open('POST', signed.url);
        request.send(body);
      });`,
};

sites["contact-form-shape"] = {
  title: "Software Engineer, AI Tasks",
  company: "Contact Form Replica",
  // The form element is the page's own: no method, no action.
  page: () => `
      <form id="role-form" data-role="software-engineer" data-apply-endpoint="/contact-form-shape/api/apply" data-thankyou="/contact-form-shape/thanks">
        <p><label for="name">Name</label><input id="name" name="name" required><span data-err="name"></span></p>
        <p><label for="email">Email</label><input id="email" name="email" type="email" required><span data-err="email"></span></p>
        <p><label for="phone">Phone, including country code</label><input id="phone" name="phone" type="tel" required><span data-err="phone"></span></p>
        <p class="chk"><input id="consent" name="consent" type="checkbox" required><label for="consent">The company can contact me about this role. I have read the privacy policy.</label><span data-err="consent"></span></p>
        <span data-err="submit" role="alert"></span>
        <button type="submit" data-testid="apply">Apply</button>
      </form>`,
  script: `
      const form = document.getElementById('role-form');
      const setErr = (name, message) => { form.querySelector('[data-err="' + name + '"]').textContent = message || ''; };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        let ok = true;
        for (const name of ['name', 'email', 'phone']) {
          const value = form.elements[name].value.trim();
          setErr(name, value ? '' : 'Required');
          if (!value) ok = false;
        }
        if (!form.elements.phone.value.trim().startsWith('+')) { setErr('phone', 'Include your country code, starting with +.'); ok = false; }
        setErr('consent', form.elements.consent.checked ? '' : 'Please agree before continuing');
        if (!form.elements.consent.checked) ok = false;
        if (!ok) return;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        fetch(form.getAttribute('data-apply-endpoint'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: form.getAttribute('data-role'),
            name: form.elements.name.value.trim(),
            email: form.elements.email.value.trim(),
            phone: form.elements.phone.value.trim(),
          }),
        })
          .then((response) => response.json().then((data) => ({ response, data })))
          .then(({ response, data }) => {
            if (!response.ok || !data.ok) throw new Error(data.error || String(response.status));
            location.href = data.next || form.getAttribute('data-thankyou');
          })
          .catch(() => {
            button.disabled = false;
            setErr('submit', 'Something went wrong sending your application. Please try again.');
          });
      });`,
};

sites["lever-shape"] = {
  title: "Embedded Engineer",
  company: "Posting Replica",
  form: () => `
      <p><label for="name">Full name ✱</label><input id="name" name="name" required></p>
      <p><label for="email">Email ✱</label><input id="email" name="email" type="email" required></p>
      <p><label for="phone">Phone</label><input id="phone" name="phone"></p>
      <div><label for="resume-upload-input">Resume/CV ✱</label>
        <input id="resume-upload-input" name="resume" type="file" required>
        <span class="resume-upload-working" hidden>Uploading…</span>
        <span class="resume-upload-success" hidden>Success!</span>
        <span class="resume-upload-failure" hidden>Couldn't auto-read resume.</span></div>
      <input type="hidden" name="accountId" value="0a1b2c3d-4e5f-4789-8bcd-ef0123456789">
      <input type="hidden" name="resumeStorageId" value="">`,
  script: `
      const touched = new Set();
      for (const id of ['name', 'email', 'phone'])
        for (const type of ['change', 'paste'])
          document.getElementById(id).addEventListener(type, () => touched.add(id));
      const show = (name) => {
        for (const state of ['working', 'success', 'failure'])
          document.querySelector('.resume-upload-' + state).hidden = state !== name;
      };
      const sanitize = (name) => name.replace(/[<>:"/\\\\|?*\\s]/g, '_').replace(/^\\.+|\\.+$/g, '').replace(/^_+|_+$/g, '').replace(/_+/g, '_') || 'untitled';
      document.getElementById('resume-upload-input').addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (!file || file.size === 0) return;
        show('working');
        const body = new FormData();
        body.append('resume', file, sanitize(file.name));
        body.append('accountId', document.querySelector('input[name=accountId]').value);
        const request = new XMLHttpRequest();
        request.onreadystatechange = () => {
          if (request.readyState !== 4) return;
          let profile = null;
          try { profile = request.status === 200 ? JSON.parse(request.response) : null; } catch {}
          if (!profile) return show('failure');
          show('success');
          for (const id of ['name', 'email', 'phone'])
            if (!touched.has(id) || !document.getElementById(id).value)
              document.getElementById(id).value = profile[id] || '';
          document.querySelector('input[name=resumeStorageId]').value = profile.resumeStorageId;
        };
        request.open('POST', '/lever-shape/parseResume');
        request.send(body);
      });`,
};

function storageOrigin(req) {
  const port = /:(\d+)$/u.exec(req.headers.host ?? "")?.[1] ?? "80";
  return `http://localhost:${port}`;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

function json(res, status, value) {
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

async function ashbyGraphql(req, res, url, { readPost, logPost }) {
  const body = await readPost(req);
  const op = url.searchParams.get("op") ?? body.operationName;
  const variables = body.variables ?? {};
  const state = ashbyForms.get(variables.formRenderIdentifier) ?? {};
  ashbyForms.set(variables.formRenderIdentifier, state);
  if (op === "ApiCreateFileUploadHandle") {
    // A real presign crosses the Atlantic: the page waits on it before the
    // storage POST, often longer than a press waits for the page to go quiet.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const key = `uploads/7f3a9c21/${Date.now()}-${variables.filename ?? "file"}`;
    return json(res, 200, {
      data: {
        fileUploadHandle: {
          handle: Buffer.from(`handle:${key}`).toString("base64"),
          url: `${storageOrigin(req)}/ashby-shape/storage/`,
          fields: {
            acl: "private",
            bucket: "synthetic-ashby-files",
            ...s3Signing,
            "X-Amz-Security-Token": securityToken,
            key,
            Policy: ashbyPolicy,
            "X-Amz-Signature": "a".repeat(64),
          },
          __typename: "FileUploadHandle",
        },
      },
    });
  }
  if (op === "ApiAutocompleteGeoLocation") {
    const text = String(variables.text ?? "").toLowerCase();
    const names = [
      "Albania",
      "Germany",
      "Kosovo",
      "Portugal",
      "United Kingdom",
    ];
    return json(res, 200, {
      data: {
        result: {
          suggestions: (text
            ? names.filter((name) => name.toLowerCase().includes(text))
            : []
          ).map((name) => ({
            name,
            geoLocationPath: [
              {
                name,
                type: "Country",
                providerLocationId: `replica-${name}`,
                __typename: "GeoLocation",
              },
            ],
            __typename: "AutocompleteLocation",
          })),
          __typename: "AutocompleteLocationResult",
        },
      },
    });
  }
  if (op === "ApiSetFormValue") {
    state[variables.path] = variables.value;
    return json(res, 200, { data: { setFormValue: { id: "saved" } } });
  }
  if (op === "ApiSetFormValueToFile") {
    const key = Buffer.from(variables.fileHandle ?? "", "base64")
      .toString()
      .replace(/^handle:/u, "");
    if (!key.startsWith("uploads/"))
      return json(res, 200, { errors: [{ message: "Unknown file handle" }] });
    state[variables.path] = { file: key.split("/").at(-1) };
    return json(res, 200, { data: { setFormValueToFile: { id: "bound" } } });
  }
  if (op === "ApiSubmitSingleApplicationFormAction") {
    // The submit carries no answers: the server submits what it saved.
    const missing = ashbyFields
      .filter(
        (field) =>
          field.required &&
          (state[field.path] === undefined ||
            state[field.path] === null ||
            state[field.path] === ""),
      )
      .map((field) => field.label);
    if (!missing.length) logPost("/ashby-shape/apply/1", state);
    return json(res, 200, {
      data: {
        submitApplicationFormAction: { ok: missing.length === 0, missing },
      },
    });
  }
  return json(res, 200, { data: {} });
}

export async function handleRealUploadShapes(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  const [, slug, rest = ""] =
    /^\/(ashby-shape|greenhouse-shape|lever-shape|workable-shape|contact-form-shape)(\/.*)?$/u.exec(
      url.pathname,
    ) ?? [];
  if (!slug) return false;
  const site = sites[slug];
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  if (rest === "/storage" || rest === "/storage/") {
    // The storage origin answers the way S3 does for a POST policy upload:
    // 204, or 201 with an XML receipt when the policy asks for it.
    const fields = req.method === "POST" ? await readPost(req) : {};
    if (req.method === "POST") logPost(url.pathname, fields);
    if (fields.success_action_status === "201") {
      res.writeHead(201, { ...cors, "Content-Type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><PostResponse><Location>${storageOrigin(req)}${url.pathname}/${fields.key ?? ""}</Location><Bucket>synthetic-greenhouse-files</Bucket><Key>${fields.key ?? ""}</Key><ETag>"synthetic"</ETag></PostResponse>`,
      );
    } else {
      res.writeHead(204, cors);
      res.end();
    }
    return true;
  }
  if (rest === "/parseResume" && req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    json(res, 200, {
      name: "Parsed From File",
      email: "parsed@example.test",
      phone: "+44 20 0000 0000",
      resumeStorageId: "replica-resume-storage-1",
    });
    return true;
  }
  if (rest === "/api/non-user-graphql" && req.method === "POST") {
    await ashbyGraphql(req, res, url, { readPost, logPost });
    return true;
  }
  if (rest === "/address/validate") {
    json(res, 200, {
      valid: /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(
        url.searchParams.get("email") ?? "",
      ),
    });
    return true;
  }
  if (rest === "/api/v1/jobs/1/form/upload/resume") {
    json(res, 200, {
      downloadUrl: `${storageOrigin(req)}/workable-shape/storage/${workableKey}`,
      uploadPostUrl: {
        url: `${storageOrigin(req)}/workable-shape/storage`,
        fields: {
          utf8: "",
          bucket: "synthetic-workable-files",
          ...s3Signing,
          key: workableKey,
          Policy: workablePolicy,
          "X-Amz-Signature": "a".repeat(64),
        },
        path: workableKey,
      },
    });
    return true;
  }
  if (rest === "/uncacheable_attributes/presigned_fields") {
    json(res, 200, {
      url: `${storageOrigin(req)}/greenhouse-shape/storage`,
      resume: {
        key: "uploads/{timestamp}-{unique_id}/${filename}",
        fields: {
          "x-amz-server-side-encryption": "AES256",
          success_action_status: "201",
          policy: greenhousePolicy,
          "x-amz-credential": s3Signing["X-Amz-Credential"],
          "x-amz-algorithm": s3Signing["X-Amz-Algorithm"],
          "x-amz-date": s3Signing["X-Amz-Date"],
          "x-amz-signature": "a".repeat(64),
        },
      },
    });
    return true;
  }
  if (rest === "/api/apply" && req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    json(res, 200, { ok: true, next: `/${slug}/thanks` });
    return true;
  }
  if (rest === "/thanks") {
    send(200, "<h1>Thanks for applying</h1><p>We'll be in touch.</p>");
    return true;
  }
  if (rest === "/apply/1" && req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    send(200, "<h1>Thank you! Your application has been received.</h1>");
    return true;
  }
  if (rest === "/jobs/1") {
    send(
      200,
      `<h1>${site.title}</h1><p>${site.company} · Remote, Worldwide</p><p>Build the tools teams ship with.</p><a href="/${slug}/apply/1">Apply</a>`,
    );
    return true;
  }
  if (rest === "/apply/1") {
    const body = site.page
      ? site.page()
      : slug === "ashby-shape"
        ? // Ashby's page has no <form>; Submit has no type, like its Yes/No buttons.
          `<div id="application">${site.form()}<button id="send">Submit Application</button></div>`
        : `<form method="post" action="/${slug}/apply/1" enctype="multipart/form-data">
        ${site.form()}<button>Submit application</button>
      </form>`;
    send(
      200,
      `<!doctype html><title>Apply — ${site.company}</title>
      <div id="toast" role="status"></div>
      <h1>Apply: ${site.title}</h1><p>${site.company} · Remote, Worldwide</p>
      ${body}<script>${site.script}</script>`,
    );
    return true;
  }
  send(404, "Not found");
  return true;
}
