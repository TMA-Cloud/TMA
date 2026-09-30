import { describe, expect, it } from 'vitest';

import { jsonForScript } from '../../../utils/htmlSafe.js';

describe('jsonForScript', () => {
  const lineSep = String.fromCharCode(0x2028);
  const value = { name: `</script><img src=x onerror=alert(1)>&${lineSep}` };

  it('leaves no character that can end the script element', () => {
    const out = jsonForScript(value);
    expect(out).not.toMatch(/[<>&]/);
    expect(out).not.toContain(lineSep);
  });

  it('still parses back to the original value', () => {
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
  });
});
