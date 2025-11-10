import js from "@eslint/js";
import globals from "globals";

const baseConfig = js.configs.recommended;
const baseLanguageOptions = baseConfig.languageOptions ?? {};

export default [
  {
    ignores: ["node_modules/", "coverage/", "dist/"],
  },
  {
    ...baseConfig,
    files: ["**/*.js"],
    languageOptions: {
      ...baseLanguageOptions,
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...baseLanguageOptions.globals,
        ...globals.node,
      },
    },
    rules: {
      ...baseConfig.rules,
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        ...baseLanguageOptions.globals,
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ...baseLanguageOptions,
      globals: {
        ...baseLanguageOptions.globals,
        ...globals.browser,
      },
    },
  },
];
