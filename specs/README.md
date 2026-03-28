# specs/ Directory

This directory contains requirements and specifications for the Tesla Charger application.

## Structure

```
specs/
├── pending/       # Specifications that need to be implemented
├── completed/    # Specifications that have been implemented
├── architecture/ # High-level architecture decisions
└── guides/       # Best practices and how-to guides
```

## Creating a Spec

Each spec file should:

1. **Focus on one topic of concern** - Can be described in one sentence without "and"
2. **Describe the desired behavior** - What should happen, not how to implement
3. **Include acceptance criteria** - How to verify the spec is met

## Naming

- Use kebab-case: `solar-forecast-caching.md`
- Be descriptive: `exchange-rate-sync.md` not `exchange.md`

## Example

```markdown
# Solar Forecast Caching

## Problem

The solcast adapter fetches forecast data on every request, even when recent data is available.

## Solution

Implement a caching layer that stores forecast data and returns cached results within a TTL window.

## Acceptance Criteria

- [ ] Cache expires after 30 minutes
- [ ] Cache key includes location parameters
- [ ] Manual cache invalidation available
- [ ] Cache misses trigger fresh fetch
```

## Spec Lifecycle

1. **Create** - Add new spec to `specs/pending/`
2. **Implement** - Ralph Auto loop implements from spec
3. **Complete** - User moves spec to `specs/completed/` when satisfied

The Ralph Auto loop reads specs from `specs/pending/` and `specs/completed/` but will NOT move files between directories. Only the user should move completed specs.