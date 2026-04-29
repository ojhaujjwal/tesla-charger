import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow @ts-expect-error and @ts-ignore comments"
    },
    messages: {
      noTsIgnore: "Do not use {{ directive }}. Fix the underlying type error instead."
    },
    schema: []
  },
  create(context) {
    return {
      Program(node) {
        for (const comment of node.comments) {
          const match = comment.value.match(/@(ts-expect-error|ts-ignore)/);
          if (match) {
            context.report({
              node: comment,
              messageId: "noTsIgnore",
              data: { directive: match[0] }
            });
          }
        }
      }
    };
  }
});
