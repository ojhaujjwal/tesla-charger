import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow process global. Use @effect/platform for platform-agnostic code."
    },
    messages: {
      noProcess:
        "Do not use 'process'. Use @effect/platform services (e.g., Terminal, Environment) for platform-agnostic code."
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node) {
        const isDirectProcess = node.object.type === "Identifier" && node.object.name === "process";

        const isGlobalThisProcess =
          node.object.type === "MemberExpression" &&
          node.object.object.type === "Identifier" &&
          node.object.object.name === "globalThis" &&
          node.object.property.type === "Identifier" &&
          node.object.property.name === "process";

        if (isDirectProcess || isGlobalThisProcess) {
          const propertyName = node.property.type === "Identifier" ? node.property.name : null;

          if (propertyName === "argv") {
            return;
          }

          context.report({
            node,
            messageId: "noProcess"
          });
        }
      }
    };
  }
});
