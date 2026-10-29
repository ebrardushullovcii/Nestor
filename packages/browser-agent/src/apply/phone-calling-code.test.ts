import { expect, test } from "vitest";
import { phoneCallingCode } from "./phone-answer";
test.each([
  ["+49 555 0000000", "+49"],
  ["+383 44 555 555", "+383"],
  ["+1 (202) 555-0100", "+1"],
  ["+7 999 555 0100", "+7"],
  ["0555 0000000", null],
  ["0049 5550000000", null],
  ["+999123456", null],
  ["+49 extension 3", null],
])("explicit calling code from %s", (phone, code) =>
  expect(phoneCallingCode(phone)).toBe(code),
);
