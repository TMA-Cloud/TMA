import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import house from '../eslint-rules/house.js';

/**
 * The house rules are the only thing keeping the microcopy and type-scale
 * conventions from drifting back, so they get the same treatment as app code:
 * every message a rule can emit has a case that provokes it, and every shape
 * the codebase actually uses has a case proving it stays quiet.
 */
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('house/toast-copy', () => {
  it('flags filler and lets plain messages through', () => {
    ruleTester.run('toast-copy', house.rules['toast-copy'], {
      valid: [
        "showToast('Session revoked', 'success')",
        "showToast('Failed to load share links', 'error')",
        // Interpolation counts toward the budget but does not trip the checks.
        "showToast(`Moved ${count} items to trash`, 'success')",
        // Multi-sentence copy keeps its stops.
        "showToast('Opened on desktop. Changes sync back.', 'success')",
        // An ellipsis marks progress rather than ending a sentence.
        "showToast('Already opening this file...', 'info')",
        // Not a toast.
        "logger.info('Saved successfully.')",
        // Non-literal messages are the server's to word.
        "showToast(error.message, 'error')",
      ],
      invalid: [
        {
          code: "showToast('Session revoked successfully', 'success')",
          errors: [{ messageId: 'successfully' }],
        },
        {
          code: "showToast('Sub-user removed!', 'success')",
          errors: [{ messageId: 'exclamation' }],
        },
        {
          code: "showToast('Failed to restore files. Please try again.', 'error')",
          errors: [{ messageId: 'tryAgain' }],
        },
        {
          code: "showToast('Please enter a 6-digit code', 'error')",
          errors: [{ messageId: 'politeness' }],
        },
        {
          code: "showToast('Nothing deleted | Every entry failed', 'info')",
          errors: [{ messageId: 'pipe' }],
        },
        {
          code: "showToast('Select a single file to open on desktop.', 'error')",
          errors: [{ messageId: 'trailingPeriod' }],
        },
        {
          code: `showToast('Sub-users share your files and storage quota, but log in with separate credentials', 'info')`,
          errors: [{ messageId: 'tooLong' }],
        },
        // Both branches of a ternary are copy a user can be shown.
        {
          code: "showToast(ok ? 'Saved successfully' : 'Failed to save', 'success')",
          errors: [{ messageId: 'successfully' }],
        },
        // So is the right-hand side of a fallback.
        {
          code: "showToast(err.message || 'Bulk upload failed!', 'error')",
          errors: [{ messageId: 'exclamation' }],
        },
        // And so is a getErrorMessage fallback.
        {
          code: "showToast(getErrorMessage(e, 'Failed to delete. Please try again.'), 'error')",
          errors: [{ messageId: 'tryAgain' }],
        },
      ],
    });
  });
});

describe('house/no-smart-apostrophe', () => {
  it('flags U+2019 and fixes it where the quotes can stay', () => {
    ruleTester.run('no-smart-apostrophe', house.rules['no-smart-apostrophe'], {
      valid: [`const a = "Can't open";`, "const b = 'plain text';", 'const c = `no apostrophe ${x}`;'],
      invalid: [
        {
          code: 'const a = "Can’t open";',
          output: `const a = "Can't open";`,
          errors: [{ messageId: 'smart' }],
        },
        {
          code: 'const b = `isn’t a valid ${ext} file`;',
          output: "const b = `isn't a valid ${ext} file`;",
          errors: [{ messageId: 'smart' }],
        },
        {
          // Requoting is a style call, so this one is reported without a fix.
          code: "const c = 'don’t match';",
          output: null,
          errors: [{ messageId: 'smart' }],
        },
      ],
    });
  });
});

describe('house/use-type-tokens', () => {
  it('flags Tailwind text sizes in className, ignoring other text-* utilities', () => {
    ruleTester.run('use-type-tokens', house.rules['use-type-tokens'], {
      valid: [
        '<p className="type-callout font-medium" />',
        // Colour, alignment and wrapping utilities share the prefix.
        '<p className="text-gray-500 text-left text-balance" />',
        '<p className={`type-caption ${extra}`} />',
        '<p title="text-sm" />',
      ],
      invalid: [
        {
          code: '<p className="text-sm text-gray-500" />',
          errors: [{ messageId: 'tailwindSize', data: { cls: 'text-sm' } }],
        },
        {
          code: '<h1 className="text-4xl md:text-6xl font-bold" />',
          errors: [{ messageId: 'tailwindSize' }],
        },
        {
          code: '<p className={`text-xs ${tone}`} />',
          errors: [{ messageId: 'tailwindSize' }],
        },
        {
          code: '<p className="text-[11px]" />',
          errors: [{ messageId: 'tailwindSize' }],
        },
      ],
    });
  });
});
