import type { Rule } from 'eslint';

declare const plugin: {
  meta: { name: string };
  rules: {
    'toast-copy': Rule.RuleModule;
    'no-smart-apostrophe': Rule.RuleModule;
    'use-type-tokens': Rule.RuleModule;
    'no-raw-theme-color': Rule.RuleModule;
    'no-transition-all': Rule.RuleModule;
    'no-vendor-names': Rule.RuleModule;
    'no-number-input': Rule.RuleModule;
  };
};

export default plugin;
