import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);

function isNodeBuiltin(source: string): boolean {
  if (source.startsWith("node:")) return true;
  const [prefix] = source.split("/");
  return NODE_BUILTINS.has(prefix);
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow node: imports since this project uses @effect/platform for platform-agnostic code"
    },
    messages: {
      noNodeImport: "Do not use 'node:' imports. Use @effect/platform instead for platform-agnostic code.",
      noBareNodeImport:
        "Do not use Node.js built-in imports (e.g. 'fs', 'path'). Use @effect/platform instead for platform-agnostic code."
    },
    schema: []
  },
  create(context) {
    function checkImportSource(node: ESTree.Node, source: string | null | undefined) {
      if (!source || typeof source !== "string") return;

      if (source.startsWith("node:")) {
        context.report({
          node,
          messageId: "noNodeImport"
        });
      } else if (isNodeBuiltin(source)) {
        context.report({
          node,
          messageId: "noBareNodeImport"
        });
      }
    }

    return {
      ImportDeclaration(node) {
        checkImportSource(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkImportSource(node, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        checkImportSource(node, node.source.value);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && callee.name === "require") {
          const arg = node.arguments[0];
          if (arg && arg.type === "Literal" && typeof arg.value === "string") {
            checkImportSource(node, arg.value);
          }
        }
      }
    };
  }
});
