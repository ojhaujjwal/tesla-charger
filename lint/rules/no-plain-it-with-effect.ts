import { defineRule } from "@oxlint/plugins";

const EFFECT_PATTERNS = /Effect\.gen|Effect\.andThen|Effect\.flatMap|Effect\.provide|yield\*|\$\{.*Effect/i;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require it.effect() instead of it() for tests that use Effect values. Plain it() never executes the Effect, causing false passes."
    },
    messages: {
      noPlainItWithEffect:
        "Use it.effect() instead of it() for tests containing Effect code. Plain it() captures but never executes the Effect, causing false passes."
    },
    schema: []
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "it") {
          return;
        }

        if (node.arguments.length === 0) {
          return;
        }

        const callback = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0];

        if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
          return;
        }

        const source = context.sourceCode.getText(callback);

        if (EFFECT_PATTERNS.test(source)) {
          context.report({
            node,
            messageId: "noPlainItWithEffect"
          });
        }
      }
    };
  }
});
