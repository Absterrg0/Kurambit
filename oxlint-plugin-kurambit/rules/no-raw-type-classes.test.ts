import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("kurambit/no-raw-type-classes", { filename: "fixture.tsx" });
const capped = createOxlintRuleHarness("kurambit/no-raw-type-classes", {
  filename: "fixture.tsx",
  ruleOptions: [{ maxOccurrences: 2 }],
});

describe("kurambit/no-raw-type-classes", () => {
  rule.valid(
    "allows type roles and text colours",
    `const el = <p className="text-meta text-muted-foreground text-balance">Hi</p>;`,
  );

  rule.invalid(
    "reports a raw size under a variant",
    `const el = <p className="sm:text-xs">Hi</p>;`,
    (output) => assert.match(output, /text-xs is a raw type class/),
  );

  rule.invalid(
    "reports a raw weight",
    `const el = <p className={cn("font-medium", open && "text-sm")}>Hi</p>;`,
    (output) => assert.match(output, /font-medium is a raw type class/),
  );

  capped.valid(
    "allows raw classes up to the file's ceiling",
    `const a = "text-sm"; const b = "font-medium";`,
  );

  capped.invalid(
    "reports a file over its ceiling",
    `const a = "text-sm"; const b = "font-medium"; const c = "text-xs";`,
    (output) => assert.match(output, /text-xs is a raw type class/),
  );

  capped.invalid("reports a ceiling the file no longer needs", `const a = "text-sm";`, (output) =>
    assert.match(output, /Lower its maxOccurrences in vite.config.ts to 1/),
  );
});
