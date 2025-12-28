# Tesla Charger - Agent Guide

## Build/Lint/Test Commands
- Build: `npm run build` (TypeScript compilation)
- Lint: `npm run lint:fix`
- Test: `npm test` (runs Vitest)
- Run single test: `npm test -- src/tests/unit/path/to/test.test.ts`

## Code Style

### Module System & Imports
- ES Modules only (type: "module" in package.json)
- Use .js extensions in imports for TypeScript files (verbatimModuleSyntax: true)
- Import order: external packages first, then internal modules with .js extension
- Example: `import { App } from './app.js';`

### TypeScript
- Strict mode enabled with exactOptionalPropertyTypes
- Use `type` not `interface` (@typescript-eslint/consistent-type-definitions)
- Explicit return types on public methods
- No implicit any or returns

### Effect-TS Framework
- **Before implementing Effect features**, run `effect-solutions list` and read the relevant guide
- Topics include: services and layers, data modeling, error handling, configuration, testing, HTTP clients, CLIs, observability, and project structure
- When encountering Effect compiler errors, use effect-solutions to understand and fix them
- **Effect Source Reference:** `~/.local/share/effect-solutions/effect` - Search here for real implementations when docs aren't enough

### Naming & Style
- Classes: PascalCase
- Files: kebab-case.ts (e.g., excess-solar-aggresive-controller.ts)
- Types: PascalCase with descriptive names
