import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow @ts-nocheck comments"
    },
    messages: {
      noTsNocheck: "Do not use @ts-nocheck. Fix the underlying type errors instead."
    },
    schema: []
  },
  create(context) {
    return {
      Program(node) {
        for (const comment of node.comments) {
          if (comment.value.includes("@ts-nocheck")) {
            context.report({
              node: comment,
              messageId: "noTsNocheck"
            });
          }
        }
      }
    };
  }
});
