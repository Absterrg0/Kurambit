import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("kurambit/no-sparkles-icon", {
  filename: "fixture.tsx",
});

describe("kurambit/no-sparkles-icon", () => {
  rule.valid(
    "allows icons that say what the control does",
    `import { ImagesIcon, ShieldCheckIcon } from "lucide-react";`,
  );

  rule.valid("allows the word in copy", `const label = "Sparkles";`);

  rule.invalid(
    "reports a sparkles import from lucide-react",
    `import { SparklesIcon } from "lucide-react";`,
    (output) => {
      assert.match(output, /Sparkles says 'AI'/);
    },
  );

  rule.invalid(
    "reports a renamed sparkle import",
    `import { Sparkle as Shine } from "lucide-react";`,
    (output) => {
      assert.match(output, /Sparkles says 'AI'/);
    },
  );
});
