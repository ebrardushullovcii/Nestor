import process from "node:process";
/** Never retain authentication material or private model continuation state. */
export function traceSafe(value) {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, val]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|MFA_CODE)$/i.test(key) &&
        val &&
        val.length > 3,
    )
    .map(([, val]) => val);
  const cleanText = (text) => {
    for (const secret of secrets)
      text = text.split(secret).join("[secret omitted]");
    return text
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [secret omitted]")
      .replace(
        /([?&](?:access_token|id_token|token|code|key|api_key|password)=)[^&#\s"']*/gi,
        "$1[secret omitted]",
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[secret omitted]@");
  };
  const visit = (item) => {
    if (typeof item === "string") {
      // Tool arguments and DB JSON columns are often serialized JSON.
      if (/^\s*[[{]/.test(item)) {
        try {
          const parsed = JSON.parse(item);
          const cleaned = visit(parsed);
          return JSON.stringify(parsed) === JSON.stringify(cleaned)
            ? cleanText(item)
            : JSON.stringify(cleaned);
        } catch {
          /* prose */
        }
      }
      return cleanText(item);
    }
    if (Array.isArray(item))
      return item
        .filter(
          (v) =>
            !v ||
            typeof v !== "object" ||
            !("type" in v) ||
            v.type !== "reasoning",
        )
        .map(visit);
    if (!item || typeof item !== "object") return item;
    if (item instanceof Error)
      return { name: item.name, message: cleanText(item.message) };
    const record = item;
    if (
      typeof record.type === "string" &&
      /reasoning.*(?:delta|done)/i.test(record.type)
    )
      return { type: record.type, omitted: "private reasoning" };
    // A fill command naming a secret control must not record its value.
    const secretControl =
      /password|one.time|verification.code|mfa|otp|token|csrf|sessionid/i.test(
        [
          record.name,
          record.label,
          record.autocomplete,
          record.credentialRole,
          record.type,
          record.kind,
        ]
          .filter((v) => typeof v === "string")
          .join(" "),
      );
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key, val]) => {
          if (/^(?:reasoning_content|encrypted_content)$/i.test(key))
            return false;
          return !(
            key === "continuation" &&
            val &&
            typeof val === "object" &&
            val.kind === "reasoning_content"
          );
        })
        .map(([key, val]) => [
          key,
          (/^(?:authorization|cookies?|set-cookie|password|passwd|access_token|refresh_token|id_token|api_key|apiKey|secret|mfaCode|otp)$/i.test(
            key,
          ) &&
            !(
              val &&
              typeof val === "object" &&
              typeof val.type === "string" &&
              ["string", "object", "array", "number", "boolean"].includes(
                val.type,
              )
            )) ||
          (secretControl && /^(?:value|text|answer)$/i.test(key))
            ? "[secret omitted]"
            : visit(val),
        ]),
    );
  };
  return visit(value);
}
