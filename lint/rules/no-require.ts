import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow require() calls. Use ES module imports instead."
    },
    messages: {
      noRequire: "Do not use require(). Use ES module imports instead."
    },
    schema: []
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && callee.name === "require") {
          context.report({
            node,
            messageId: "noRequire"
          });
        }
      }
    };
  }
});
