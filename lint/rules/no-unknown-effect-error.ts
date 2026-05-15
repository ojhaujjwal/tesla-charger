import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow unknown in Effect.Effect error type position"
    },
    messages: {
      unknownEffectError:
        "Do not use `unknown` in the error channel of Effect.Effect. Use explicit error types to preserve Effect's type-safe error handling."
    },
    schema: []
  },
  create(context) {
    return {
      TSTypeReference(node) {
        const typeName = node.typeName;
        if (
          typeName?.type === "TSQualifiedName" &&
          typeName.left?.type === "Identifier" &&
          typeName.left.name === "Effect" &&
          typeName.right?.type === "Identifier" &&
          typeName.right.name === "Effect"
        ) {
          if (node.typeArguments) {
            const params = node.typeArguments.params;
            if (params.length >= 2 && params[1]?.type === "TSUnknownKeyword") {
              context.report({
                node: params[1],
                messageId: "unknownEffectError"
              });
            }
          }
        }
      }
    };
  }
});
