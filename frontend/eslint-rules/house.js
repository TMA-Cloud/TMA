/**
 * House rules for user-facing text and type sizing.
 *
 * These encode conventions that are easy to state and easy to forget: a toast
 * is read in passing, so every word has to earn its place, and the type ladder
 * only holds if sizes come from the design tokens rather than from Tailwind's
 * rem scale, which this app's 13px root quietly shrinks.
 */

const MAX_TOAST_LENGTH = 70;

/** Rough stand-in width for an interpolated value, for the length budget. */
const PLACEHOLDER_WIDTH = 10;

/**
 * Collects the user-visible string literals reachable from a toast argument.
 *
 * Messages are rarely a bare literal: they arrive through `a || 'fallback'`,
 * `cond ? 'a' : 'b'`, or `getErrorMessage(err, 'fallback')`. Each branch that
 * bottoms out in a literal is text a user can actually be shown, so each one
 * is worth checking.
 */
function collectMessages(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, text: node.value, exact: true });
      break;
    case 'TemplateLiteral': {
      const text = node.quasis.map(q => q.value.cooked ?? '').join('');
      const budget = text.length + node.expressions.length * PLACEHOLDER_WIDTH;
      out.push({ node, text, exact: false, budget });
      break;
    }
    case 'ConditionalExpression':
      collectMessages(node.consequent, out);
      collectMessages(node.alternate, out);
      break;
    case 'LogicalExpression':
      collectMessages(node.left, out);
      collectMessages(node.right, out);
      break;
    case 'CallExpression': {
      // `getErrorMessage(error, 'fallback')` — the fallback is shown verbatim.
      const name = node.callee.type === 'Identifier' ? node.callee.name : node.callee.property?.name;
      if (name === 'getErrorMessage' && node.arguments[1]) collectMessages(node.arguments[1], out);
      break;
    }
    default:
      break;
  }
  return out;
}

function isShowToast(node) {
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === 'showToast';
  return callee.type === 'MemberExpression' && callee.property?.name === 'showToast';
}

const toastCopy = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep toast messages short, plain, and free of filler' },
    schema: [{ type: 'object', properties: { maxLength: { type: 'number' } }, additionalProperties: false }],
    messages: {
      successfully: 'Drop "successfully" — the success icon already carries that meaning.',
      exclamation: 'No exclamation marks in toasts; state the outcome plainly.',
      tryAgain: '"Please try again" adds nothing — the user can already see the action failed.',
      politeness: 'Drop the leading "Please" — say what to do: "Enter a positive number".',
      pipe: 'Use an em dash rather than "|" to join clauses.',
      trailingPeriod: 'No trailing period on a single-sentence toast.',
      tooLong: 'Toast is {{length}} chars; keep it under {{max}} so it reads at a glance.',
    },
  },
  create(context) {
    const max = context.options[0]?.maxLength ?? MAX_TOAST_LENGTH;

    return {
      CallExpression(node) {
        if (!isShowToast(node) || node.arguments.length === 0) return;

        for (const { node: target, text, exact, budget } of collectMessages(node.arguments[0])) {
          if (!text.trim()) continue;

          if (/successfully/i.test(text)) context.report({ node: target, messageId: 'successfully' });
          if (/!/.test(text)) context.report({ node: target, messageId: 'exclamation' });
          if (/please try again/i.test(text)) context.report({ node: target, messageId: 'tryAgain' });
          if (/^please\b/i.test(text.trim())) context.report({ node: target, messageId: 'politeness' });
          if (/\s\|\s/.test(text)) context.report({ node: target, messageId: 'pipe' });

          // Only a lone sentence: multi-sentence messages keep their stops, and
          // an ellipsis is a progress marker rather than a full stop.
          const trimmed = text.trim();
          if (trimmed.endsWith('.') && !trimmed.endsWith('...') && !/[.!?]/.test(trimmed.slice(0, -1))) {
            context.report({ node: target, messageId: 'trailingPeriod' });
          }

          const length = exact ? text.length : budget;
          if (length > max) {
            context.report({ node: target, messageId: 'tooLong', data: { length, max } });
          }
        }
      },
    };
  },
};

const noSmartApostrophe = {
  meta: {
    type: 'problem',
    fixable: 'code',
    docs: { description: 'Use the ASCII apostrophe; U+2019 is easily confused with a backtick' },
    messages: { smart: "Use an ASCII apostrophe (') instead of U+2019." },
  },
  create(context) {
    const CURLY = '’';

    /**
     * Only rewrites when the delimiters can stay as they are. Turning
     * `'don’t'` into `'don't'` would need the quotes swapped too, which is
     * a judgement call about the surrounding style rather than a safe fix.
     */
    const fixIfSafe = (raw, range) => {
      const replaced = raw.split(CURLY).join("'");
      if (raw.startsWith("'") && replaced.slice(1, -1).includes("'")) return null;
      return fixer => fixer.replaceTextRange(range, replaced);
    };

    const check = node => {
      const raw = context.sourceCode.getText(node);
      if (!raw.includes(CURLY)) return;
      const fix = fixIfSafe(raw, node.range);
      context.report({ node, messageId: 'smart', ...(fix ? { fix } : {}) });
    };

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node);
      },
      TemplateElement(node) {
        check(node);
      },
      JSXText(node) {
        check(node);
      },
    };
  },
};

/**
 * Tailwind's rem-based sizes, plus arbitrary pixel values. The lookahead does
 * the work `\b` cannot: it has to reject `text-smoke` while still accepting
 * `text-[11px]`, which ends in a non-word character.
 */
const TAILWIND_TEXT_SIZE = /\btext-(?:xs|sm|base|lg|[2-9]?xl)(?![\w-])|\btext-\[\d+(?:\.\d+)?px\]/;

/**
 * Every className a rule can usefully see: a bare string, a template, or the
 * literal arms of the conditionals these components are built from. Shared so
 * the class-name rules below all recognise the same shapes.
 */
function classNameVisitor(check) {
  const walk = (node, report) => {
    if (!node) return;
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string') report(node, node.value);
        break;
      case 'TemplateLiteral':
        report(node, node.quasis.map(q => q.value.cooked ?? '').join(' '));
        break;
      case 'ConditionalExpression':
        walk(node.consequent, report);
        walk(node.alternate, report);
        break;
      case 'LogicalExpression':
        walk(node.left, report);
        walk(node.right, report);
        break;
      default:
        break;
    }
  };

  return {
    JSXAttribute(node) {
      if (node.name.name !== 'className' || !node.value) return;
      const v = node.value;
      walk(v.type === 'JSXExpressionContainer' ? v.expression : v, check);
    },
    /** Class strings also live in lookup tables and `const base = '...'`. */
    VariableDeclarator(node) {
      if (!node.init) return;
      if (/class(Name)?$|^btn|Classes$/i.test(node.id.name ?? '')) walk(node.init, check);
    },
    Property(node) {
      if (node.value?.type === 'Literal' && typeof node.value.value === 'string') {
        // Only strings that look like class lists, so data is left alone.
        if (/(^|\s)(bg|text|border|ring|rounded|flex|grid|p[xytblr]?|m[xytblr]?)-/.test(node.value.value)) {
          check(node.value, node.value.value);
        }
      }
    },
  };
}

const useTypeTokens = {
  meta: {
    type: 'problem',
    docs: { description: 'Size text with the .type-* tokens, not Tailwind text-* utilities' },
    messages: {
      tailwindSize:
        'Use a .type-* token instead of "{{cls}}". The root font-size is 13px, so text-sm renders at 11.4px, not 14px. ' +
        '(title-3 17px, callout 14px, footnote 13px, caption 12px)',
    },
  },
  create(context) {
    return classNameVisitor((node, value) => {
      const match = value.match(TAILWIND_TEXT_SIZE);
      if (match) context.report({ node, messageId: 'tailwindSize', data: { cls: match[0] } });
    });
  },
};

/** An arbitrary colour value baked into a utility: `bg-[#ffffff]`, `text-[#333]`. */
const RAW_COLOR =
  /\b(?:bg|text|border|ring|from|via|to|fill|stroke|shadow|outline|decoration|accent|caret|divide|placeholder)-\[#[0-9a-fA-F]{3,8}\]/;

const noRawThemeColor = {
  meta: {
    type: 'problem',
    docs: { description: 'Colour from the theme tokens so both themes stay in step' },
    messages: {
      rawColor:
        'Use a theme token instead of "{{cls}}". A literal colour only suits one theme, and it sidesteps the ' +
        'contrast the tokens are tuned for. Reach for bg-[var(--surface)], text-[var(--label-secondary)], ' +
        'border-[var(--separator)], or a material-* class.',
    },
  },
  create(context) {
    return classNameVisitor((node, value) => {
      const match = value.match(RAW_COLOR);
      if (match) context.report({ node, messageId: 'rawColor', data: { cls: match[0] } });
    });
  },
};

const noTransitionAll = {
  meta: {
    type: 'problem',
    docs: { description: 'Transition named properties rather than everything' },
    messages: {
      transitionAll:
        'Name the properties instead of "transition-all". It animates every property that changes — including ' +
        'colours and layout the compositor cannot handle — so a transform meant to be cheap starts costing ' +
        'layout. Prefer transition-[opacity,transform] or transition-colors.',
    },
  },
  create(context) {
    return classNameVisitor((node, value) => {
      if (/\btransition-all\b/.test(value)) context.report({ node, messageId: 'transitionAll' });
    });
  },
};

/**
 * Comments explain why a decision holds, and a vendor's name is not a reason.
 * Naming the source also dates badly and reads as posturing rather than
 * argument — the rationale has to survive without the borrowed authority.
 */
const VENDOR_NAMES = [
  { re: /\bapple(?:'s)?\b/i, name: 'Apple' },
  { re: /\bcupertino\b/i, name: 'Cupertino' },
  { re: /\bWWDC\b/, name: 'WWDC' },
  { re: /\bhuman interface guidelines\b/i, name: 'Human Interface Guidelines' },
  { re: /\bHIG\b/, name: 'HIG' },
  { re: /\biOS\b/, name: 'iOS' },
  { re: /\biPadOS\b/, name: 'iPadOS' },
  { re: /\bmacOS\b/, name: 'macOS' },
  { re: /\bmaterial design\b/i, name: 'Material Design' },
  { re: /\bfluent design\b/i, name: 'Fluent Design' },
];

const noVendorNames = {
  meta: {
    type: 'problem',
    docs: { description: 'Explain the reasoning in comments rather than citing a vendor' },
    messages: {
      vendor:
        'Drop "{{name}}" from the comment and say why the rule holds instead. Borrowed authority is not an ' +
        'argument, and it reads as posturing.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          for (const { re, name } of VENDOR_NAMES) {
            if (re.test(comment.value)) {
              context.report({ node: comment, messageId: 'vendor', data: { name } });
              break;
            }
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'house' },
  rules: {
    'toast-copy': toastCopy,
    'no-smart-apostrophe': noSmartApostrophe,
    'use-type-tokens': useTypeTokens,
    'no-raw-theme-color': noRawThemeColor,
    'no-transition-all': noTransitionAll,
    'no-vendor-names': noVendorNames,
  },
};
