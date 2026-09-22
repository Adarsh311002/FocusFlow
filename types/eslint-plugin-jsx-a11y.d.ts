// eslint-plugin-jsx-a11y ships no type declarations. Only the flat config that
// eslint.config.ts uses is declared here.
declare module 'eslint-plugin-jsx-a11y' {
  import type { Linter } from 'eslint';

  const plugin: {
    flatConfigs: {
      recommended: Linter.Config;
    };
  };

  export default plugin;
}
