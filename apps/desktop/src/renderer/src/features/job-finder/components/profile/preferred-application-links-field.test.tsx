// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, expect, test } from "vitest";
import {
  CandidateProfileSchema,
  normalizePublicLinkUrl,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  buildProfilePayload,
  type ProfileEditorValues,
} from "../../lib/profile-editor";
import { PreferredApplicationLinksField } from "./preferred-application-links-field";

afterEach(cleanup);
let latest: ProfileEditorValues | undefined;
function Harness({
  duplicate = false,
  previous = false,
  field = "personalWebsiteUrl",
  url = "https://example.test/portfolio",
}: {
  url?: string;
  duplicate?: boolean;
  previous?: boolean;
  field?: "personalWebsiteUrl" | "portfolioUrl";
}) {
  const form = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(
      CandidateProfileSchema.parse({
        id: "synthetic_links",
        yearsExperience: null,
        baseResume: {
          id: "synthetic_resume",
          fileName: "synthetic.txt",
          uploadedAt: "2026-10-04T10:00:00.000Z",
        },
        [field]: url,
        links: duplicate
          ? [
              {
                id: "portfolio",
                label: "Illustration portfolio",
                kind: "portfolio",
                url: normalizePublicLinkUrl(url),
              },
            ]
          : previous
            ? [
                {
                  id: "contact_website",
                  label: "Old Website",
                  kind: "website",
                  url: "https://example.test/old",
                },
              ]
            : [],
      }),
    ),
  });
  const values = form.watch();
  latest = values;
  return (
    <>
      <PreferredApplicationLinksField fieldId="links" profileForm={form} />
      <button onClick={() => form.reset(form.getValues())}>Save links</button>
    </>
  );
}
test.each([
  ["personalWebsiteUrl", "Website"],
  ["portfolioUrl", "Portfolio"],
] as const)("R3-054 selects %s without entering it again", (field, label) => {
  render(<Harness field={field} />);
  expect(screen.queryByText(/No public links/)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(latest?.links).toHaveLength(1);
  expect(latest?.links[0]).toMatchObject({
    label,
    url: "https://example.test/portfolio",
  });
  expect(latest?.applicationIdentity.preferredLinkIds).toBe(
    latest?.links[0]?.id,
  );
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("checkbox"));
  expect(latest?.links).toHaveLength(1);
});
test("R3-054 displays a shared Website and public portfolio URL once", () => {
  render(<Harness duplicate />);
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(screen.getByText("Illustration portfolio")).toBeTruthy();
});
test("R3-054 can include an updated Website when an earlier address was already selected", () => {
  render(<Harness previous />);
  fireEvent.click(screen.getAllByRole("checkbox")[1]!);
  expect(latest?.links).toHaveLength(2);
  expect(new Set(latest?.links.map((link) => link.id)).size).toBe(2);
  expect(latest?.links[1]?.url).toBe("https://example.test/portfolio");
  expect(latest?.applicationIdentity.preferredLinkIds).toBe(
    latest?.links[1]?.id,
  );
});

test("normalizes a bare-domain Portfolio and drops the unsaved link when unticked", () => {
  render(<Harness field="portfolioUrl" url="hannahberg.example.com" />);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(latest?.links[0]?.url).toBe("https://hannahberg.example.com/");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(latest?.links).toEqual([]);
  expect(latest?.applicationIdentity.preferredLinkIds).toBe("");
});

test("an invalid public link names the field when saving", () => {
  const profile = CandidateProfileSchema.parse({
    id: "links_validation",
    yearsExperience: null,
    baseResume: {
      id: "resume",
      fileName: "test.txt",
      uploadedAt: "2026-10-04T00:00:00.000Z",
    },
  });
  const values = createProfileEditorValues(profile);
  values.links = [
    { id: "bad", label: "Portfolio", kind: "portfolio", url: "not a url" },
  ];
  expect(buildProfilePayload(profile, values).validationMessage).toBe(
    "Portfolio must be a web address, like example.com.",
  );
});

test("unticking a previously saved synthetic contact link keeps the public link", () => {
  render(<Harness field="portfolioUrl" url="hannahberg.example.com" />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save links" }));
  fireEvent.click(screen.getByRole("checkbox"));
  expect(latest?.links).toHaveLength(1);
  expect(latest?.applicationIdentity.preferredLinkIds).toBe("");
});

test("shows an imported canonical portfolio and its bare contact address once", () => {
  render(
    <Harness duplicate field="portfolioUrl" url="hannahberg.example.com" />,
  );
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(latest?.links).toHaveLength(1);
});
