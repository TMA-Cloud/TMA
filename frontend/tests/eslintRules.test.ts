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

describe('house/no-raw-theme-color', () => {
  it('flags literal colours baked into utilities, and leaves tokens alone', () => {
    ruleTester.run('no-raw-theme-color', house.rules['no-raw-theme-color'], {
      valid: [
        '<div className="bg-[var(--surface)] text-[var(--label-secondary)]" />',
        '<div className="material-thick material-edge" />',
        // The remapped Tailwind scales resolve to the palette.
        '<div className="bg-slate-100 text-gray-500" />',
        // Arbitrary values that are not colours.
        '<div className="max-h-[70vh] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]" />',
        // A hex outside a colour utility is somebody else's concern.
        '<div title="#ffffff" />',
        // Icon libraries take colours as props, not classes.
        "<FileIcon color='#0078D4' />",
      ],
      invalid: [
        {
          code: '<div className="bg-[#ffffff] p-4" />',
          errors: [{ messageId: 'rawColor', data: { cls: 'bg-[#ffffff]' } }],
        },
        {
          code: '<p className="text-[#8e8e93]" />',
          errors: [{ messageId: 'rawColor' }],
        },
        {
          code: '<div className={`border-[#ccc] ${extra}`} />',
          errors: [{ messageId: 'rawColor' }],
        },
        // Both arms of a conditional are class strings a user can be shown.
        {
          code: "<div className={on ? 'bg-[#007aff]' : 'bg-[var(--surface)]'} />",
          errors: [{ messageId: 'rawColor' }],
        },
        // Class lookup tables are the other place these hide.
        {
          code: "const toneClasses = { neutral: 'bg-[#ffffff] border' };",
          errors: [{ messageId: 'rawColor' }],
        },
      ],
    });
  });
});

describe('house/no-transition-all', () => {
  it('flags transition-all and accepts named properties', () => {
    ruleTester.run('no-transition-all', house.rules['no-transition-all'], {
      valid: [
        '<div className="transition-[opacity,transform] duration-300" />',
        '<div className="transition-colors" />',
        '<div className="transition-transform" />',
        // Not a class list.
        '<div title="transition-all" />',
      ],
      invalid: [
        {
          code: '<div className="transition-all duration-300" />',
          errors: [{ messageId: 'transitionAll' }],
        },
        {
          code: '<div className={`transition-all ${extra}`} />',
          errors: [{ messageId: 'transitionAll' }],
        },
      ],
    });
  });
});

describe('house/no-number-input', () => {
  it('flags the number input type and leaves the other types alone', () => {
    ruleTester.run('no-number-input', house.rules['no-number-input'], {
      valid: [
        '<NumberInput value={size} onValueChange={setSize} />',
        '<input type="text" inputMode="decimal" />',
        '<input type="password" />',
        // A wrapper is free to give `type` whatever meaning it wants.
        '<Field type="number" />',
        // Not a JSX type attribute at all.
        "const input = { type: 'number' };",
      ],
      invalid: [
        {
          code: '<input type="number" min="0" step="0.01" />',
          errors: [{ messageId: 'numberInput' }],
        },
        {
          code: "<input type={'number'} />",
          errors: [{ messageId: 'numberInput' }],
        },
      ],
    });
  });
});

describe('house/no-vendor-names', () => {
  it('flags borrowed authority in comments and leaves the reasoning alone', () => {
    ruleTester.run('no-vendor-names', house.rules['no-vendor-names'], {
      valid: [
        '// Neutral ramp, light end to dark end.\nconst a = 1;',
        '/* Parameterised the way a designer thinks about it. */\nconst b = 2;',
        // The rule reads comments, so identifiers and user-facing strings are
        // out of scope: this maps a platform id to a label people recognise.
        "const label = platform === 'darwin' ? 'macOS' : 'Windows';",
        // Substrings must not trip the word boundaries.
        '// The ratios applied here are deliberate.\nconst c = 3;',
      ],
      invalid: [
        {
          code: "// Apple's system colors, wired into Tailwind.\nconst a = 1;",
          errors: [{ messageId: 'vendor', data: { name: 'Apple' } }],
        },
        {
          code: '/* Mac and iOS get San Francisco. */\nconst b = 2;',
          errors: [{ messageId: 'vendor', data: { name: 'iOS' } }],
        },
        {
          code: '// Straight from the Human Interface Guidelines.\nconst c = 3;',
          errors: [{ messageId: 'vendor' }],
        },
        {
          code: '// Follows Material Design elevation.\nconst d = 4;',
          errors: [{ messageId: 'vendor', data: { name: 'Material Design' } }],
        },
      ],
    });
  });
});

describe('house/transition-covers-motion', () => {
  it('flags a transform-only transition beside a standalone motion utility', () => {
    ruleTester.run('transition-covers-motion', house.rules['transition-covers-motion'], {
      valid: [
        // The shorthand names scale, translate and rotate as well.
        '<div className="opacity-0 scale-[0.96] transition-motion duration-300" />',
        '<div className="-translate-x-full transition-motion" />',
        // A transform transition with nothing standalone beside it is fine.
        '<div className="transition-transform hover:opacity-50" />',
        // Static centring with no transition at all.
        '<div className="absolute left-1/2 -translate-x-1/2" />',
        // transition-all covers every property, including the standalone ones.
        '<div className="scale-95 transition-all" />',
      ],
      invalid: [
        {
          code: '<div className="opacity-0 scale-[0.96] transition-[opacity,transform] duration-300" />',
          errors: [{ messageId: 'uncovered', data: { props: 'scale' } }],
        },
        {
          code: '<div className="rotate-180 transition-transform duration-200" />',
          errors: [{ messageId: 'uncovered', data: { props: 'rotate' } }],
        },
        {
          code: '<div className="-translate-x-full transition-transform" />',
          errors: [{ messageId: 'uncovered', data: { props: 'translate' } }],
        },
        // The modal exit that started this: two properties, one message.
        {
          code: '<div className="translate-y-4 scale-[0.96] transition-[opacity,transform]" />',
          errors: [{ messageId: 'uncovered', data: { props: 'scale and translate' } }],
        },
        {
          code: "<div className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />",
          errors: [{ messageId: 'uncovered' }],
        },
      ],
    });
  });
});

describe('class-name rules see inside template interpolations', () => {
  /**
   * The shape that let the modal stutter ship: the offending classes were in a
   * conditional inside a `${...}`, and a walker reading only the static quasis
   * never saw them. Every class-name rule is checked against that shape.
   */
  const insideInterpolation = '<div className={`base ${on ? "PAYLOAD" : "other"}`} />';

  it('finds a raw colour in a branch of an interpolation', () => {
    ruleTester.run('no-raw-theme-color', house.rules['no-raw-theme-color'], {
      valid: [],
      invalid: [
        {
          code: insideInterpolation.replace('PAYLOAD', 'bg-[#ffffff]'),
          errors: [{ messageId: 'rawColor' }],
        },
      ],
    });
  });

  it('finds transition-all in a branch of an interpolation', () => {
    ruleTester.run('no-transition-all', house.rules['no-transition-all'], {
      valid: [],
      invalid: [
        {
          code: insideInterpolation.replace('PAYLOAD', 'transition-all duration-300'),
          errors: [{ messageId: 'transitionAll' }],
        },
      ],
    });
  });

  it('pairs a utility in the static part with its transition in a branch', () => {
    ruleTester.run('transition-covers-motion', house.rules['transition-covers-motion'], {
      valid: [
        // Split across the same boundary, but the shorthand covers it.
        '<div className={`scale-95 ${on ? "transition-motion" : ""}`} />',
      ],
      invalid: [
        // The utility and the transition are in different fragments; only a
        // rule that reads the whole list can see they belong together.
        {
          code: '<div className={`scale-95 ${on ? "transition-transform" : ""}`} />',
          errors: [{ messageId: 'uncovered', data: { props: 'scale' } }],
        },
        {
          code: insideInterpolation.replace('PAYLOAD', 'rotate-180 transition-transform'),
          errors: [{ messageId: 'uncovered', data: { props: 'rotate' } }],
        },
      ],
    });
  });
});
