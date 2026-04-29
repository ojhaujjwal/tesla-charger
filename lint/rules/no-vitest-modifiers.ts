import { defineRule } from "@oxlint/plugins";

const MODIFIERS = new Set(["skip", "only"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow it.skip, it.only, describe.skip, and describe.only in tests. Skipping hides failures and only causes CI to miss tests."
    },
    messages: {
      noVitestModifier:
        "Do not use {{ caller }}.{{ modifier }}(). Fix or remove the test instead of skipping or focusing it."
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed) return;

        const { object, property } = node;

        if (
          object.type === "Identifier" &&
          (object.name === "it" || object.name === "describe") &&
          property.type === "Identifier" &&
          MODIFIERS.has(property.name)
        ) {
          context.report({
            node,
            messageId: "noVitestModifier",
            data: { caller: object.name, modifier: property.name }
          });
        }
      }
    };
  }
});
