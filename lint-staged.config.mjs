/**
 * @filename: lint-staged.config.mjs
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.{ts}": ["oxfmt --write", "oxlint --disable-nested-config --fix"]
};
