import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow console methods. Use Effect.Console or Effect.log instead."
    },
    messages: {
      noConsole: "Do not use 'console.{{ method }}'. Use Effect.Console or Effect.log instead."
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "console" &&
          node.property.type === "Identifier"
        ) {
          context.report({
            node,
            messageId: "noConsole",
            data: { method: node.property.name }
          });
        }
      }
    };
  }
});
