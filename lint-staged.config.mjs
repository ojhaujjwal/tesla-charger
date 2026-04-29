/**
 * @filename: lint-staged.config.mjs
 * @type {import('lint-staged').Configuration}
 */
export default {
  "*.ts": ["oxfmt --write", "sh -c 'PATH=\"$PATH:./node_modules/.bin\" NODE_OPTIONS=\"--import tsx/esm\" oxlint --disable-nested-config --fix \"$@\"' sh"]
};
