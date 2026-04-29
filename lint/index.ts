import { definePlugin } from "@oxlint/plugins";
import noOxlintDisable from "./rules/no-oxlint-disable.js";
import noEffectIgnore from "./rules/no-effect-ignore.js";
import noEffectCatchallcause from "./rules/no-effect-catchallcause.js";
import noEffectAsvoid from "./rules/no-effect-asvoid.js";
import noSilentErrorSwallow from "./rules/no-silent-error-swallow.js";
import noServiceOption from "./rules/no-service-option.js";
import noNestedLayerProvide from "./rules/no-nested-layer-provide.js";
import pipeMaxArguments from "./rules/pipe-max-arguments.js";
import preferOptionFromNullable from "./rules/prefer-option-from-nullable.js";
import importExtensions from "./rules/import-extensions.js";
import noDisableValidation from "./rules/no-disable-validation.js";
import noVoidExpression from "./rules/no-void-expression.js";
import noNodeImports from "./rules/no-node-imports.js";
import noRequire from "./rules/no-require.js";
import noProcess from "./rules/no-process.js";
import noBunGlobals from "./rules/no-bun-globals.js";
import noConsole from "./rules/no-console.js";
import noPlainItWithEffect from "./rules/no-plain-it-with-effect.js";
import noVitestModifiers from "./rules/no-vitest-modifiers.js";
import noTsIgnore from "./rules/no-ts-ignore.js";

export default definePlugin({
  meta: { name: "tesla-charger" },
  rules: {
    "no-oxlint-disable": noOxlintDisable,
    "no-effect-ignore": noEffectIgnore,
    "no-effect-catchallcause": noEffectCatchallcause,
    "no-effect-asvoid": noEffectAsvoid,
    "no-silent-error-swallow": noSilentErrorSwallow,
    "no-service-option": noServiceOption,
    "no-nested-layer-provide": noNestedLayerProvide,
    "pipe-max-arguments": pipeMaxArguments,
    "prefer-option-from-nullable": preferOptionFromNullable,
    "import-extensions": importExtensions,
    "no-disable-validation": noDisableValidation,
    "no-void-expression": noVoidExpression,
    "no-node-imports": noNodeImports,
    "no-require": noRequire,
    "no-process": noProcess,
    "no-bun-globals": noBunGlobals,
    "no-console": noConsole,
    "no-plain-it-with-effect": noPlainItWithEffect,
    "no-vitest-modifiers": noVitestModifiers,
    "no-ts-ignore": noTsIgnore
  }
});
