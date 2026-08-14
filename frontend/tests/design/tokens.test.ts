import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the design foundation against the failure that is hardest to notice
 * by looking: a theme that is individually plausible but quietly weaker than
 * its counterpart.
 *
 * The light theme originally reused the same alpha values as the dark one, on
 * the assumption that a token at 62% means the same thing in both directions.
 * It does not — white text at 62% on near-black lands near 6:1 while black at
 * the same alpha on white lands near 4:1 — and the small meta text ended up at
 * 2.18:1, well under the 4.5:1 that size needs. Nothing about the CSS looked
 * wrong; it only showed up when someone compared the two themes side by side.
 *
 * So these assertions are about measured ratios rather than about which values
 * were written down, and every one is checked in both themes.
 */

const SRC = join(__dirname, '..', '..', 'src');
const indexCss = readFileSync(join(SRC, 'index.css'), 'utf-8');
const cursorsCss = readFileSync(join(SRC, 'cursors.css'), 'utf-8');

// --- CSS extraction -------------------------------------------------------

/** Body of the first block whose selector matches, brace-matched. */
function block(css: string, selector: RegExp): string {
  const start = css.search(selector);
  if (start === -1) throw new Error(`no block matching ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

function tokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values can span lines (the cursor data URIs do), so read to the semicolon.
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim().replace(/\s+/g, ' ');
  }
  return out;
}

/** `:root` and `.dark` as they are written inside `@layer base`, ignoring the
 *  accessibility media queries further down the file. */
function themes(css: string) {
  const base = block(css, /@layer base/);
  return {
    light: tokens(block(base, /(^|\n)\s*:root\s*\{/)),
    dark: tokens(block(base, /\.dark,\s*\n?\s*html\.dark\s*\{/)),
  };
}

const T = themes(indexCss);
const C = themes(cursorsCss);

/** Dark inherits everything it does not restate. */
const resolved = {
  light: T.light,
  dark: { ...T.light, ...T.dark },
};

// --- Colour ---------------------------------------------------------------

type RGBA = [number, number, number, number];

function parseColor(value: string): RGBA {
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [...n, a];
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const p = fn[1]!
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`cannot parse colour: ${value}`);
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const luminance = ([r, g, b]: RGBA) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** A token is only ever seen blended, so alpha is composited before measuring. */
const composite = (fg: RGBA, bg: RGBA): RGBA => [
  fg[0] * fg[3] + bg[0] * (1 - fg[3]),
  fg[1] * fg[3] + bg[1] * (1 - fg[3]),
  fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  1,
];

function contrast(theme: 'light' | 'dark', fgToken: string, bgToken: string): number {
  const set = resolved[theme];
  const fg = parseColor(set[fgToken] ?? '');
  const bg = parseColor(set[bgToken] ?? '');
  const [hi, lo] = [luminance(composite(fg, bg)) + 0.05, luminance(bg) + 0.05].sort((a, b) => b - a);
  return hi! / lo!;
}

const THEMES = ['light', 'dark'] as const;
const GROUNDS = ['--canvas', '--surface'] as const;

/** WCAG AA for text below ~18.66px bold / 24px regular. */
const AA_TEXT = 4.5;
/** WCAG AA for icons, controls and other non-text marks. */
const AA_NON_TEXT = 3;

// --- Tests ----------------------------------------------------------------

describe('theme completeness', () => {
  const REQUIRED = [
    '--canvas',
    '--surface',
    '--label',
    '--label-secondary',
    '--label-tertiary',
    '--label-on-accent',
    '--separator',
    '--separator-strong',
    '--accent',
    '--accent-hover',
    '--accent-fill',
    '--accent-ring',
    '--positive',
    '--warning',
    '--destructive',
    '--positive-text',
    '--warning-text',
    '--destructive-text',
    '--scrim',
    '--material-chrome',
    '--material-thick',
  ];

  it.each(REQUIRED)('defines %s in the light theme', token => {
    expect(T.light[token], `${token} missing from :root`).toBeDefined();
  });

  it.each(REQUIRED)('defines %s in the dark theme', token => {
    expect(resolved.dark[token], `${token} resolves to nothing in dark`).toBeDefined();
  });

  it('never introduces a token in dark that light has no value for', () => {
    const orphans = Object.keys(T.dark).filter(k => !(k in T.light));
    expect(orphans, 'dark-only tokens fall back to nothing in light').toEqual([]);
  });
});

describe('text contrast clears WCAG AA', () => {
  const TEXT_ROLES = ['--label', '--label-secondary', '--label-tertiary'];

  for (const theme of THEMES) {
    for (const ground of GROUNDS) {
      it.each(TEXT_ROLES)(`${theme}: %s on ${ground}`, role => {
        const ratio = contrast(theme, role, ground);
        expect(ratio, `${role} on ${ground} in ${theme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});

describe('semantic colours', () => {
  const ROLES = ['positive', 'warning', 'destructive'] as const;

  for (const theme of THEMES) {
    for (const ground of GROUNDS) {
      it.each(ROLES)(`${theme}: --%s-text is legible on ${ground}`, role => {
        const ratio = contrast(theme, `--${role}-text`, ground);
        expect(ratio, `--${role}-text on ${ground} in ${theme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          AA_TEXT
        );
      });
    }
  }

  // The plain fills are for sitting on, not reading. This is the assertion that
  // stops someone "simplifying" the split back into one token per role.
  it.each(ROLES)('--%s stays a fill and is not mistaken for a text colour', role => {
    const asText = contrast('light', `--${role}`, '--surface');
    const asTextRole = contrast('light', `--${role}-text`, '--surface');
    expect(asTextRole).toBeGreaterThan(asText);
  });

  it.each(THEMES)('%s: label-on-accent is readable on the accent', theme => {
    const ratio = contrast(theme, '--label-on-accent', '--accent');
    expect(ratio, `label-on-accent is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each(THEMES)('%s: separators are actually visible', theme => {
    for (const ground of GROUNDS) {
      expect(contrast(theme, '--separator', ground)).toBeGreaterThan(1.15);
    }
  });
});

describe('the two themes carry the same weight', () => {
  /**
   * The real defect was never an absolute number — it was one theme reading
   * markedly weaker than the other. Ratios within this factor of each other
   * are indistinguishable in use; the shipped bug sat at 1.81.
   */
  const MAX_DIVERGENCE = 1.4;

  it.each(['--label', '--label-secondary', '--label-tertiary'])('%s reads alike in both themes', role => {
    const light = contrast('light', role, '--canvas');
    const dark = contrast('dark', role, '--canvas');
    const divergence = Math.max(light, dark) / Math.min(light, dark);
    expect(divergence, `${role} is ${light.toFixed(2)}:1 light vs ${dark.toFixed(2)}:1 dark`).toBeLessThanOrEqual(
      MAX_DIVERGENCE
    );
  });
});

describe('type scale', () => {
  const scale = [...indexCss.matchAll(/\.type-([\w-]+)\s*\{([^}]+)\}/g)].map(m => {
    const body = m[2]!;
    const size = body.match(/font-size:\s*([\d.]+)rem/);
    const tracking = body.match(/letter-spacing:\s*(-?[\d.]+)em/);
    const leading = body.match(/line-height:\s*([\d.]+)/);
    return {
      name: m[1]!,
      size: size ? Number(size[1]) : null,
      tracking: tracking ? Number(tracking[1]) : null,
      leading: leading ? Number(leading[1]) : null,
    };
  });

  const sized = scale.filter(s => s.size !== null && s.tracking !== null);

  it('has a scale to check', () => {
    expect(sized.length).toBeGreaterThanOrEqual(6);
  });

  it('gives every step a size, a leading and a tracking', () => {
    for (const step of sized) {
      expect(step.leading, `.type-${step.name} has no line-height`).not.toBeNull();
    }
  });

  /**
   * Tracking is size-specific or it is wrong somewhere: letters read further
   * apart as they grow, so large text needs it pulled in and small text needs
   * a touch of air. A single value across the scale fails this.
   */
  it('tightens tracking as the size grows', () => {
    const ordered = [...sized].sort((a, b) => a.size! - b.size!);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]!;
      const step = ordered[i]!;
      if (step.size === prev.size) continue;
      expect(
        step.tracking,
        `.type-${step.name} (${step.size}rem) tracks wider than .type-${prev.name} (${prev.size}rem)`
      ).toBeLessThanOrEqual(prev.tracking!);
    }
  });

  it('does not use one tracking value for the whole scale', () => {
    expect(new Set(sized.map(s => s.tracking)).size).toBeGreaterThan(2);
  });

  it('opens the leading up as the text gets smaller', () => {
    const largest = [...sized].sort((a, b) => b.size! - a.size!)[0]!;
    const smallest = [...sized].sort((a, b) => a.size! - b.size!)[0]!;
    expect(largest.leading!).toBeLessThan(smallest.leading!);
  });
});

describe('pointers', () => {
  const names = Object.keys(C.light).filter(k => k.startsWith('--cursor-'));

  it('defines a pointer set', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('themes every pointer', () => {
    expect(
      Object.keys(C.dark)
        .filter(k => k.startsWith('--cursor-'))
        .sort()
    ).toEqual([...names].sort());
  });

  it.each(['light', 'dark'] as const)('%s: every pointer has an image, a hotspot and a fallback', theme => {
    for (const name of names) {
      const value = C[theme][name]!;
      expect(value, `${name} is not an svg data uri`).toMatch(/^url\("data:image\/svg\+xml,/);
      // Chrome refuses an SVG cursor without intrinsic dimensions.
      expect(value, `${name} has no explicit size`).toMatch(/width='24' height='24'/);
      const hotspot = value.match(/\)\s*(\d+)\s+(\d+)\s*,\s*([\w-]+)\s*$/);
      expect(hotspot, `${name} has no "<x> <y>, <fallback>" tail`).not.toBeNull();
      const [x, y] = [Number(hotspot![1]), Number(hotspot![2])];
      expect(x, `${name} hotspot x is outside the 24px box`).toBeLessThanOrEqual(24);
      expect(y, `${name} hotspot y is outside the 24px box`).toBeLessThanOrEqual(24);
      // A keyword fallback keeps the pointer sane if the image is refused.
      expect(hotspot![3], `${name} falls back to nothing`).toBeTruthy();
    }
  });

  it('actually redraws each pointer for the dark theme', () => {
    for (const name of names) {
      expect(C.dark[name], `${name} is identical in both themes`).not.toEqual(C.light[name]);
    }
  });

  it('keeps the hotspot identical across themes', () => {
    const tail = (v: string) => v.match(/\)\s*(\d+\s+\d+)\s*,/)?.[1];
    for (const name of names) {
      expect(tail(C.dark[name]!), `${name} hotspot moves between themes`).toEqual(tail(C.light[name]!));
    }
  });
});

describe('motion shorthand', () => {
  /**
   * The modal close shipped with a visible stutter because the exit named
   * `transform` while Tailwind had compiled `scale-[0.96]` to the standalone
   * `scale` property. Opacity eased over 260ms; scale snapped on frame one.
   * The shorthand exists so that pairing cannot come apart again.
   */
  const motion = block(indexCss, /\.transition-motion\s*\{/);
  const declared = (motion.match(/transition-property:\s*([^;]+);/)?.[1] ?? '').split(',').map(s => s.trim());

  it.each(['opacity', 'transform', 'scale', 'translate', 'rotate'])('transitions %s', prop => {
    expect(declared, `.transition-motion omits ${prop}`).toContain(prop);
  });

  /**
   * The same trap in raw CSS: a rule that transitions `transform` and is used
   * on elements carrying Tailwind scale/translate utilities.
   */
  const REUSABLE: ReadonlyArray<readonly [string, RegExp]> = [
    ['.pressable', /\.pressable\s*\{/],
    ['.hover-lift', /\.hover-lift\s*\{/],
    ['.btn', /\n\.btn\s*\{/],
  ];

  it.each(REUSABLE)('%s covers the standalone properties too', (name, selector) => {
    const body = block(indexCss, selector);
    const props = body.match(/transition:\s*([\s\S]*?);/)?.[1] ?? '';
    expect(props, `${name} declares no transition`).not.toEqual('');
    expect(props, `${name} transitions transform but not scale`).toMatch(/\bscale\b/);
  });
});
