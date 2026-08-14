import type { Rule } from 'eslint';

declare const plugin: {
  meta: { name: string };
  rules: {
    'toast-copy': Rule.RuleModule;
    'no-smart-apostrophe': Rule.RuleModule;
    'use-type-tokens': Rule.RuleModule;
  };
};

export default plugin;
