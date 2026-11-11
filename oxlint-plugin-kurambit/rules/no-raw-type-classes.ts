import { defineRule, type ESTree } from "@oxlint/plugins";

// A raw font size or weight utility, under any variants: text-sm, md:text-xs,
// font-medium. The seven roles (text-title … text-micro) carry both instead.
const RAW_TYPE_CLASS =
  /(?:^|\s)(?:[\w-]+:)*!?((?:text-(?:[2-3]xs|xs|sm|base|lg|[2-9]?xl))|(?:font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)))(?=\s|$)/gu;

const readMaxOccurrences = (options: ReadonlyArray<unknown>): number => {
  const [first] = options;
  return typeof first === "object" &&
    first !== null &&
    "maxOccurrences" in first &&
    typeof first.maxOccurrences === "number"
    ? first.maxOccurrences
    : 0;
};

const rawClasses = (text: string) => [...text.matchAll(RAW_TYPE_CLASS)].map((match) => match[1]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Text takes a type role (<Text variant> or text-title … text-micro), not a raw size or weight class.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxOccurrences: {
            type: "integer",
            minimum: 0,
            description:
              "This file's ceiling of raw classes. It only goes down: a file under it is reported until the ceiling matches.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    const ceiling = readMaxOccurrences(context.options);
    let count = 0;
    const check = (node: ESTree.Node, text: string) => {
      for (const utility of rawClasses(text)) {
        count++;
        if (count <= ceiling) continue;
        context.report({
          node,
          message: `${utility} is a raw type class. Use a type role: <Text variant="label|body|meta|caption|…">, or text-title … text-micro with a text tier.`,
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(" "));
      },
      "Program:exit"(node: ESTree.Node) {
        if (count < ceiling)
          context.report({
            node,
            message: `This file has ${count} raw type classes, under its ceiling of ${ceiling}. Lower its maxOccurrences in vite.config.ts to ${count}.`,
          });
      },
    };
  },
});
