// Ported from T3 Code (MIT, Copyright (c) T3 Tools Inc.), web-only.
import { defineRule } from "@oxlint/plugins";

const SPARKLE_NAME = /sparkle/iu;

const MESSAGE =
  "Sparkles says 'AI', not what the control does. Pick an icon for the action itself, such as Images for generated art or ShieldCheck for Auto mode.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow sparkles icons; they label a control as AI instead of saying what it does.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "lucide-react") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (SPARKLE_NAME.test(imported)) context.report({ node: specifier, message: MESSAGE });
        }
      },
    };
  },
});
