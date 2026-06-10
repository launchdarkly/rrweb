// Cross-package types resolve through the @highlight-run-aliased d.ts files
// (see vite.config.default.ts / tsconfig.base.json), which degrades some
// imported types to `any`. The unsafe-* family produces false positives on
// such code, so report it without failing lint.
module.exports = {
  rules: {
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/restrict-template-expressions': 'warn',
  },
};
