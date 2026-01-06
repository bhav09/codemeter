/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  ignorePatterns: ["**/dist/**", "**/out/**", "**/node_modules/**"],
  rules: {
    // Keep MVP friction low; tighten later if desired.
    "@typescript-eslint/no-explicit-any": "off"
  }
};



