import { defineRule } from "@oxlint/plugins";

const FORBIDDEN_BUN_APIS: ReadonlySet<string> = new Set([
  "env",
  "spawn",
  "spawnSync",
  "write",
  "stdout",
  "stderr",
  "stdin",
  "argv",
  "file",
  "serve",
  "fetch",
  "gc",
  "inspect",
  "password",
  "resolve",
  "sleepSync",
  "which"
]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Bun globals. Use @effect/platform services for platform-agnostic code."
    },
    messages: {
      noBunGlobal:
        "Do not use 'Bun.{{ prop }}'. Use @effect/platform services (e.g., FileSystem, Command, Terminal, Environment, Config) instead."
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "Bun" &&
          node.property.type === "Identifier" &&
          FORBIDDEN_BUN_APIS.has(node.property.name)
        ) {
          context.report({
            node,
            messageId: "noBunGlobal",
            data: { prop: node.property.name }
          });
        }
      }
    };
  }
});
