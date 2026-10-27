// The small chores around a form, in the shapes boards use: a cookie banner
// over the page, an "Apply for this job" button that reveals the form, a
// region list that loads for the chosen country with a GET, a GET autosave
// on that same choice, and work history rows added with "Add another
// position". Only the final Submit application sends the application.

const regions = {
  PT: ["Lisboa", "Porto", "Algarve"],
  DE: ["Berlin", "Bayern", "Hamburg"],
  GB: ["Greater London", "North West", "Scotland"],
};

const page = `<!doctype html><title>Apply — Chores Replica</title>
<div id="consent" role="dialog" aria-label="Cookie choices" style="position:fixed;inset:auto 0 0 0;background:#eee;padding:1em">
  <p>We use cookies to keep this site working and to measure visits.</p>
  <button type="button" data-consent="all">Accept all</button>
  <button type="button" data-consent="necessary">Reject all</button>
</div>
<h1>Apply: Integration Engineer</h1><p>Chores Replica · Remote, Europe</p>
<p>Connect the systems our customers run on.</p>
<button type="button" id="open">Apply for this job</button>
<p id="consent-status" role="status"></p>
<form id="application" method="post" action="/fill-chores/apply/1" enctype="multipart/form-data" hidden>
  <p><label for="first">First name *</label><input id="first" name="first" required></p>
  <p><label for="last">Last name *</label><input id="last" name="last" required></p>
  <p><label for="email">Email *</label><input id="email" name="email" type="email" required></p>
  <p><label for="country">Country of residence *</label>
    <select id="country" name="country" required><option value="">Select…</option>
      <option value="PT">Portugal</option><option value="DE">Germany</option><option value="GB">United Kingdom</option></select></p>
  <p><label for="region">Region *</label>
    <select id="region" name="region" required disabled><option value="">Choose a country first</option></select></p>
  <p><label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required></p>
  <fieldset><legend>Work history</legend><p>Add at least one position.</p>
    <div id="rows"></div>
    <button type="button" id="add-row">Add another position</button></fieldset>
  <button>Submit application</button>
</form>
<script>
  for (const button of document.querySelectorAll("[data-consent]"))
    button.addEventListener("click", () => {
      document.getElementById("consent").hidden = true;
      document.getElementById("consent-status").textContent = "Cookie choice: " + button.dataset.consent + ".";
      fetch("/fill-chores/api/consent", { method: "POST", body: new URLSearchParams({ choice: button.dataset.consent }) }).catch(() => {});
    });
  document.getElementById("open").addEventListener("click", () => {
    document.getElementById("application").hidden = false;
  });
  const region = document.getElementById("region");
  document.getElementById("country").addEventListener("change", async (event) => {
    const country = event.target.value;
    fetch("/fill-chores/api/save?field=country&value=" + encodeURIComponent(country)).catch(() => {});
    region.disabled = true;
    region.innerHTML = '<option value="">Loading…</option>';
    try {
      const list = await (await fetch("/fill-chores/api/regions?country=" + encodeURIComponent(country))).json();
      region.innerHTML = '<option value="">Select…</option>' + list.map((name) => "<option>" + name + "</option>").join("");
      region.disabled = false;
    } catch {
      region.innerHTML = '<option value="">Regions could not load</option>';
    }
  });
  let rows = 0;
  document.getElementById("add-row").addEventListener("click", () => {
    rows += 1;
    const row = document.createElement("fieldset");
    row.innerHTML = "<legend>Position " + rows + "</legend>" +
      '<label>Job title<input name="position' + rows + 'Title" required></label>' +
      '<label>Company<input name="position' + rows + 'Company" required></label>';
    document.getElementById("rows").append(row);
  });
</script>`;

export async function handleFillChores(
  req,
  res,
  url,
  { send, readPost, logPost },
) {
  if (!url.pathname.startsWith("/fill-chores/")) return false;
  const rest = url.pathname.slice("/fill-chores".length);
  if (rest === "/api/regions") {
    // Reads are logged too, so a run can show which lists it loaded.
    console.error(`fill-chores GET ${url.pathname}${url.search}`);
    send(
      200,
      JSON.stringify(regions[url.searchParams.get("country")] ?? []),
      "application/json",
    );
    return true;
  }
  if (rest === "/api/save" || rest === "/api/consent") {
    // Never reached from a Fill run: the fence refuses both.
    logPost(
      url.pathname,
      req.method === "POST"
        ? await readPost(req)
        : Object.fromEntries(url.searchParams),
    );
    send(204, "");
    return true;
  }
  if (rest === "/apply/1" && req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    send(200, "<h1>Thank you! Your application has been received.</h1>");
    return true;
  }
  if (rest === "/apply/1") {
    send(200, page);
    return true;
  }
  send(404, "Not found");
  return true;
}
