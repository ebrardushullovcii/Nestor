import { describe, expect, test } from "vitest";
import {
  checkFormReadiness,
  fileUploadProblems,
  unresolvedRequiredControls,
} from "./submit-preflight";
import { buildApplyFormObservation } from "./page-hands";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";

const control: RawApplyControl = {
  index: 0,
  tagName: "input",
  inputType: "text",
  role: "",
  id: "answer",
  name: "answer",
  label: "Address",
  groupLabel: "",
  placeholder: "",
  autocomplete: "",
  required: true,
  invalid: false,
  validationMessage: "",
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  checked: false,
  multiple: false,
  options: [],
  selectedOptionLabel: "",
};
const page: RawApplyPage = {
  url: "https://local.example/form",
  title: "Apply",
  bodyText: "Application",
  controls: [],
  actions: [
    { index: 0, label: "Send application", visible: true, disabled: false },
  ],
  links: [],
  headings: [],
  clickables: [],
  openedTabs: [],
  loading: false,
  validationErrors: [],
  stepLabel: null,
};
const observe = (overrides: Partial<RawApplyPage>) =>
  buildApplyFormObservation(
    { ...page, ...overrides },
    "2026-10-04T12:00:00.000Z",
  );

describe("form readiness", () => {
  test.each(["text", "number", "date", "month", "file"])(
    "an empty required %s cannot be ready",
    (inputType) => {
      const observation = observe({
        controls: [{ ...control, inputType, visible: inputType !== "file" }],
      });
      expect(checkFormReadiness(observation).ok).toBe(false);
      expect(unresolvedRequiredControls(observation)).toHaveLength(1);
    },
  );
  test("a rejected attached file is not ready", () => {
    expect(
      checkFormReadiness(
        observe({
          controls: [
            {
              ...control,
              inputType: "file",
              value: "resume.md",
              invalid: true,
              validationMessage: "Upload TXT or PDF",
            },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
  test("an unknown-length wizard with Next cannot be ready", () => {
    expect(
      checkFormReadiness(
        observe({
          actions: [
            { index: 0, label: "Next", visible: true, disabled: false },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
  test("a disabled send control cannot be ready even with zero required fields", () => {
    expect(
      checkFormReadiness(
        observe({ actions: [{ ...page.actions[0], disabled: true }] }),
      ).ok,
    ).toBe(false);
  });
  test("manual completion clears a missing field without trusting an old receipt", () => {
    const raw = { ...control };
    expect(checkFormReadiness(observe({ controls: [raw] })).ok).toBe(false);
    raw.value = "Synthetic address";
    expect(checkFormReadiness(observe({ controls: [raw] })).ok).toBe(true);
  });
  test("one checked skill satisfies its required group without ticking all options", () => {
    const observation = observe({
      controls: ["Analysis", "Coordination"].map((label, index) => ({
        ...control,
        index,
        name: "skills",
        label,
        groupLabel: "Skills",
        inputType: "checkbox",
        required: false,
        value: label,
        checked: index === 0,
      })),
    });
    observation.controls.forEach((entry) => {
      entry.required = true;
    });
    expect(unresolvedRequiredControls(observation)).toHaveLength(0);
    expect(checkFormReadiness(observation).ok).toBe(true);
  });
});

test("individually required declaration boxes cannot satisfy one another just because they share a name", () => {
  const observation = observe({
    controls: ["Privacy", "Background check"].map((label, index) => ({
      ...control,
      index,
      name: "declarations",
      label,
      groupLabel: "Declarations",
      inputType: "checkbox",
      value: label,
      checked: index === 0,
    })),
  });
  expect(unresolvedRequiredControls(observation)).toHaveLength(1);
  expect(checkFormReadiness(observation).ok).toBe(false);
});

test("an explicitly final review may offer Save beside Send, while earlier or unknown steps stay blocked", () => {
  const actions = [
    { index: 0, label: "Save and continue", visible: true, disabled: false },
    { index: 1, label: "Submit", visible: true, disabled: false },
  ];
  expect(
    checkFormReadiness(observe({ actions, stepLabel: "Step 4 of 4: Review" }))
      .ok,
  ).toBe(true);
  expect(
    checkFormReadiness(
      observe({ actions, stepLabel: "Step 3 of 4: Questions" }),
    ).ok,
  ).toBe(false);
  expect(checkFormReadiness(observe({ actions, stepLabel: null })).ok).toBe(
    false,
  );
  expect(
    checkFormReadiness(
      observe({
        actions: [
          { ...actions[0], disabled: false },
          { ...actions[1], disabled: true },
        ],
        stepLabel: "Step 4 of 4: Review",
      }),
    ).ok,
  ).toBe(false);
});

describe("file uploads", () => {
  const file = (
    overrides: Omit<Partial<RawApplyControl>, "upload"> & {
      upload?: Partial<NonNullable<RawApplyControl["upload"]>>;
    } = {},
  ): RawApplyControl => ({
    ...control,
    inputType: "file",
    id: "resume",
    name: "resume",
    label: "Resume",
    value: "C:\\fakepath\\Taylor-Resume.pdf",
    ...overrides,
    upload: {
      described: "",
      nearby: "Resume Attach Taylor-Resume.pdf",
      shown: false,
      ...overrides.upload,
    },
  });
  const states = (overrides: Partial<RawApplyPage>) =>
    fileUploadProblems(observe(overrides)).map((problem) => problem.state);

  test.each([
    "Failed to upload your resume",
    "File type not supported",
    "Your file is too large",
    "Upload rejected by server",
    "We could not accept that file",
    "Your file was rejected because it must be a PDF",
    "Your files were rejected",
    "Something went wrong",
    "There was a problem with your upload",
  ])("%s, wherever the site says it, is a refused upload", (message) => {
    for (const controls of [
      [file({ validationMessage: message })],
      [file({ upload: { described: message } })],
      [file({ upload: { nearby: `Resume Attach ${message}` } })],
      [file({ upload: { nearby: "Resume Attach" } })],
      // A chip naming the file is not proof: async widgets show it the
      // moment a file is picked, before the server answers.
      [file()],
    ]) {
      const observation = observe({
        controls,
        bodyText: `Application\n${message}`,
      });
      expect(fileUploadProblems(observation)).toEqual([
        expect.objectContaining({ state: "rejected" }),
      ]);
      expect(checkFormReadiness(observation).ok).toBe(false);
    }
  });

  test("a page-wide failure that names nothing stays off a file when another file could be it, and an untied server read is unconfirmed", () => {
    const letter = file({
      index: 1,
      id: "letter",
      name: "letter",
      label: "Cover letter",
      value: "C:\\fakepath\\letter.pdf",
      upload: { nearby: "Cover letter Attach letter.pdf" },
    });
    expect(
      states({
        controls: [file({ upload: { nearby: "Resume Attach" } }), letter],
        bodyText: "Application\nSomething went wrong",
      }),
    ).toEqual([]);
    // A widget that emptied its input is judged by the server's word on the
    // file Nestor gave it; an input nothing was given stays out of it.
    expect(
      states({
        controls: [file({ value: "", upload: { network: "rejected" } })],
      }),
    ).toEqual(["rejected"]);
    expect(states({ controls: [file({ value: "" })] })).toEqual([]);
    const untied = file({ upload: { network: "unconfirmed" } });
    expect(states({ controls: [untied] })).toEqual(["unconfirmed"]);
    expect(
      fileUploadProblems(observe({ controls: [untied] }), {
        confirmedByPerson: () => true,
      }),
    ).toEqual([]);
  });

  test("help text beside the field is not a failure", () => {
    const help = "Trouble uploading? Upload error help";
    expect(
      states({
        controls: [
          file({ upload: { nearby: `Resume ${help} Taylor-Resume.pdf` } }),
        ],
        bodyText: `Application\n${help}\nUnsupported files will be rejected.\nFiles cannot exceed 5 MB.`,
      }),
    ).toEqual([]);
  });

  test("a page message stays with the file it names, and never flags an empty optional field", () => {
    const controls = [
      file({ upload: { nearby: "Resume Attach" } }),
      file({
        index: 1,
        id: "letter",
        name: "letter",
        label: "Cover letter",
        value: "C:\\fakepath\\letter.pdf",
        upload: { nearby: "Cover letter Attach" },
      }),
      file({
        index: 2,
        id: "portfolio",
        name: "portfolio",
        label: "Portfolio",
        required: false,
        value: "",
        upload: { nearby: "Portfolio Attach" },
      }),
    ];
    const problems = fileUploadProblems(
      observe({
        controls,
        bodyText: "Application\nCover letter failed to upload.",
      }),
    );
    expect(
      problems.map((problem) => [problem.control.label, problem.state]),
    ).toEqual([["Cover letter", "rejected"]]);
  });

  test("the server's answer to the upload request decides over what the page shows", () => {
    const banner = "Application\nUpload failed. Please try again.";
    // Refused by the server even though the chip shows the name.
    expect(
      states({ controls: [file({ upload: { network: "rejected" } })] }),
    ).toEqual(["rejected"]);
    expect(
      states({ controls: [file({ upload: { network: "pending" } })] }),
    ).toEqual(["uploading"]);
    // A 2xx outweighs an old banner, so an accepted upload cannot loop.
    expect(
      states({
        controls: [file({ upload: { network: "accepted" } })],
        bodyText: banner,
      }),
    ).toEqual([]);
    // Without it, a fresh page failure about the file blocks, chip or not.
    expect(states({ controls: [file()], bodyText: banner })).toEqual([
      "rejected",
    ]);
  });

  test("a required input the widget emptied after a 2xx is attached, not refused", () => {
    // Greenhouse-style: the input is cleared once the storage has the file,
    // so the browser reports the empty required input as invalid.
    const emptied = file({
      value: "",
      required: true,
      invalid: true,
      validationMessage: "Please select a file.",
      upload: { network: "accepted", nearby: "Resume" },
    });
    expect(states({ controls: [emptied] })).toEqual([]);
  });

  test("a form that sends the file with the final submission counts it once nothing reports a problem", () => {
    for (const shown of [true, false])
      expect(
        checkFormReadiness(
          observe({
            controls: [file({ upload: { nearby: "Resume Attach", shown } })],
          }),
        ).ok,
      ).toBe(true);
    expect(
      states({
        controls: [file({ upload: { nearby: "Resume Uploading…" } })],
      }),
    ).toEqual(["uploading"]);
  });

  test("a refusal keeps its remedy, and other wordings and languages read as refusals", () => {
    for (const message of [
      "Upload rejected: your file must be a PDF",
      "Upload rejected, your file must be a PDF",
      "Ungültiges Dateiformat",
      "Invalid file type",
      "File size limit exceeded",
      "An error occurred while uploading your file",
      "Hochladen fehlgeschlagen",
      "Échec du téléchargement",
      "El archivo no es válido",
    ])
      expect(
        states({
          controls: [file({ upload: { nearby: `Resume ${message}` } })],
        }),
        message,
      ).toEqual(["rejected"]);
  });

  test("a report link is not a refusal, and a stale aria-invalid yields only to a 2xx with the person's word", () => {
    expect(
      states({
        controls: [
          file({
            upload: { nearby: "Resume Taylor-Resume.pdf Report an error" },
          }),
        ],
      }),
    ).toEqual([]);
    const stale = file({ invalid: true, upload: { network: "accepted" } });
    expect(states({ controls: [stale] })).toEqual(["rejected"]);
    expect(
      fileUploadProblems(observe({ controls: [stale] }), {
        confirmedByPerson: () => true,
      }),
    ).toEqual([]);
    expect(
      fileUploadProblems(observe({ controls: [file({ invalid: true })] }), {
        confirmedByPerson: () => true,
      }),
    ).toHaveLength(1);
  });

  test("standing rules beside a field never read as a refusal, and the person can settle stale text", () => {
    const rules =
      "Resume Files over 5 MB are rejected. PDF or DOCX only. Taylor-Resume.pdf";
    expect(states({ controls: [file({ upload: { nearby: rules } })] })).toEqual(
      [],
    );
    const stale = {
      controls: [file({ upload: { nearby: "Resume Upload failed" } })],
      bodyText: "Application\nYour resume could not be uploaded.",
    };
    expect(states(stale)).toEqual(["rejected"]);
    expect(
      fileUploadProblems(observe(stale), { confirmedByPerson: () => true }),
    ).toEqual([]);
    // A server refusal still counts after the person's word.
    expect(
      fileUploadProblems(
        observe({ controls: [file({ upload: { network: "rejected" } })] }),
        { confirmedByPerson: () => true },
      ),
    ).toHaveLength(1);
  });
});
