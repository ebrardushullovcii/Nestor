import replay from "../job-finder/apply-replays/saved-question-meanings.json" with { type: "json" };

/** The same four personal questions, with new wording on the next application. */
export async function handleRememberedQuestions(
  req,
  _res,
  url,
  { send, readPost, logPost },
) {
  const match = /^\/remembered\/apply\/([123])$/u.exec(url.pathname);
  if (!match) return false;
  if (req.method === "POST") {
    logPost(url.pathname, await readPost(req));
    send(200, "<h1>Thank you! Your application has been received.</h1>");
    return true;
  }
  const id = Number(match[1]);
  const questions =
    id === 3
      ? [
          "Expected annual salary in EUR",
          "Which monitoring product do you prefer and why?",
          "Have you ever been employed at GitLab?",
          "How much notice do you need to give?",
        ]
      : replay.cases
          .slice(0, 4)
          .map((entry) => (id === 1 ? entry.saved : entry.asked));
  send(
    200,
    `<!doctype html><title>Remembered questions ${id}</title>
    <main><h1>Apply: Synthetic remembered-question replay ${id}</h1>
    <form method="post" action="${url.pathname}" enctype="multipart/form-data">
      ${questions
        .map(
          (question, index) =>
            `<p><label for="q${index}">${question}</label>${
              index === 1
                ? `<textarea id="q${index}" name="q${index}" required></textarea>`
                : index === 2
                  ? `<select id="q${index}" name="q${index}" required><option value="">Select an answer</option><option>Yes</option><option>No</option></select>`
                  : `<input id="q${index}" name="q${index}" required>`
            }</p>`,
        )
        .join("")}
      <p><label for="resume">Resume</label><input id="resume" name="resume" type="file" accept=".pdf" required></p>
      <button>Submit application</button>
    </form></main>`,
  );
  return true;
}
