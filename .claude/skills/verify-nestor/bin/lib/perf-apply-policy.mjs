// What the scripted model does on an application form for `perf --load`, in
// Apply's own tools (packages/browser-agent/src/apply/apply-tools.ts): fill
// every field a stored fact or the resume answers in one fill_fields, go on
// to the next step, and leave the rest for the person, as a real Fill does.
// It reads only what the agent shows the model: the page view, the stored-
// fact catalog and the document list.

const NEXT = /^(?:save and continue|continue|next)\b/iu;
const SUBMIT = /^submit\b/iu;
// Label words to stored-fact ids, for fields a person's profile answers.
export const FACT_FOR_LABEL = [
  [/first name|given name/iu, /firstName$/u],
  [/last name|family name|surname/iu, /lastName$/u],
  [/full name|^name\b|your name/iu, /fullName$/u],
  [/e-?mail/iu, /\.email$/u],
  [/phone|mobile/iu, /phone/u],
  [/city|location|where do you live/iu, /currentLocation$/u],
  [/linkedin|professional profile/iu, /linkedin/iu],
];

function lastPageView(messages) {
  return messages.findLast((message) =>
    /Page: http\S*\n/u.test(message.content ?? ""),
  )?.content;
}

function catalog(messages) {
  const facts = new Map();
  for (const message of messages) {
    // The facts come as a sentence and then their JSON.
    const content = String(message.content ?? "");
    if (!content.includes("storedFactCatalog")) continue;
    let data;
    try {
      data = JSON.parse(content.slice(content.indexOf("{")));
    } catch {
      continue;
    }
    for (const fact of data?.storedFactCatalog ?? [])
      if (typeof fact?.value === "string") facts.set(fact.id, fact.value);
  }
  return facts;
}

function parseView(view) {
  const fields = [...view.matchAll(/^- (c\S+) \[([^\]]+)\] · (.+)$/gmu)].map(
    ([, ref, kind, rest]) => {
      const parts = rest.split(" · ");
      return {
        ref,
        kind,
        label: parts[0] ?? "",
        required: parts.includes("required"),
        empty: parts.includes("empty"),
        declaration: rest.includes("a declaration"),
        editable: !rest.includes("cannot be edited"),
      };
    },
  );
  const buttons = [...view.matchAll(/^- (a\S+): (.+)$/gmu)].map(
    ([, ref, label]) => ({
      ref,
      label,
      disabled: label.endsWith("(disabled)"),
    }),
  );
  return {
    key: `${view.match(/Page: (\S+)/u)?.[1]} ${view.match(/^Step[^\n]*$/mu)?.[0] ?? ""}`,
    fields,
    next: buttons.find((b) => NEXT.test(b.label) && !b.disabled),
    submit: buttons.find((b) => SUBMIT.test(b.label)),
  };
}

/** One tool call for this turn: { name, args }. */
export function decideApplyAction(messages) {
  const view = lastPageView(messages);
  if (!view) return { name: "observe", args: {} };
  const page = parseView(view);
  const facts = catalog(messages);
  // After submit_application Job Finder either sent the form or stopped it
  // for the person; either way this run is over.
  const lastCall = messages
    .findLast((m) => m.role === "assistant" && m.tool_calls?.length)
    ?.tool_calls?.at(-1)?.function.name;
  if (lastCall === "submit_application")
    return {
      name: "finish",
      args: { reason: "The form is complete; Job Finder has the send." },
    };
  const documentId = messages
    .map((m) => m.content ?? "")
    .join("\n")
    .match(
      /Available documents for this application[^\n]*\n- ([^:\s]+):/u,
    )?.[1];
  // A step this script already filled twice: what is left needs the person.
  let viewKey = null;
  let triesHere = 0;
  for (const message of messages) {
    if (/Page: http\S*\n/u.test(message.content ?? ""))
      viewKey = parseView(message.content).key;
    if (
      message.role === "assistant" &&
      viewKey === page.key &&
      message.tool_calls?.some((c) => c.function.name === "fill_fields")
    )
      triesHere += 1;
  }

  const entries = [];
  const leftForPerson = [];
  for (const field of page.fields) {
    if (!field.empty || !field.editable) continue;
    if (field.kind === "file") {
      if (documentId && /resume|cv/iu.test(field.label))
        entries.push({ tool: "upload", ref: field.ref, documentId });
      else if (field.required) leftForPerson.push(field);
      continue;
    }
    // A required box is ticked like a person would; Job Finder's own gate
    // decides whether it may be.
    if (field.kind === "checkbox" && (field.declaration || field.required)) {
      entries.push({ tool: "set_checkbox", ref: field.ref, checked: true });
      continue;
    }
    const match = FACT_FOR_LABEL.find(([label]) => label.test(field.label));
    const factId = match
      ? [...facts.keys()].find((id) => match[1].test(id))
      : undefined;
    if (
      factId &&
      ["text", "email", "tel", "textarea", "url"].includes(field.kind)
    )
      entries.push({
        tool: "type",
        ref: field.ref,
        text: facts.get(factId),
        storedFactId: factId,
      });
    else if (field.required) leftForPerson.push(field);
  }

  // A page with no form at all (a missing job): nothing to apply on.
  if (page.fields.length === 0 && !page.next && !page.submit)
    return {
      name: "finish",
      args: { reason: "This page has no application form.", stuck: true },
    };
  if (entries.length > 0 && triesHere < 2) {
    const args = { fields: entries };
    if (leftForPerson.length === 0) {
      if (page.next && !page.submit) args.thenContinue = page.next.ref;
    }
    return { name: "fill_fields", args };
  }
  if (leftForPerson.length > 0 || triesHere >= 2)
    return {
      name: "finish",
      args: {
        reason: `Filled what the profile answers; ${leftForPerson.length || "some"} required question(s) need the person.`,
        needsPerson: true,
      },
    };
  if (page.next && !page.submit)
    return {
      name: "click",
      args: { ref: page.next.ref, reason: "Go to the next step." },
    };
  // Complete: say so with the form's own send button. Job Finder presses it
  // only when the person allowed sending; otherwise it stops, ready.
  if (page.submit)
    return { name: "submit_application", args: { ref: page.submit.ref } };
  return {
    name: "finish",
    args: { reason: "The form is filled in and ready for the person to send." },
  };
}
