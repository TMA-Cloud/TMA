import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { NumberInput } from '../../src/components/ui/NumberInput';
import { sanitizeNumericInput } from '../../src/utils/numberInput';

/**
 * The bug this component exists for only shows up in a controlled field, so
 * the tests drive one: state and the box have to agree after every keystroke,
 * which is exactly what the number input type failed to guarantee.
 */
function Controlled({ decimal = true, initial = '' }: { decimal?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NumberInput aria-label="Size" value={value} onValueChange={setValue} decimal={decimal} />
      <output>{value}</output>
    </>
  );
}

describe('sanitizeNumericInput', () => {
  it('keeps digits and a single decimal point', () => {
    expect(sanitizeNumericInput('12.5')).toBe('12.5');
    expect(sanitizeNumericInput('1.2.3')).toBe('1.23');
    expect(sanitizeNumericInput('.5')).toBe('.5');
  });

  it('drops the characters the number input type would have swallowed', () => {
    expect(sanitizeNumericInput('12e')).toBe('12');
    expect(sanitizeNumericInput('1e5')).toBe('15');
    expect(sanitizeNumericInput('-3')).toBe('3');
    expect(sanitizeNumericInput('+3')).toBe('3');
  });

  it('rejects the decimal point outright for whole-number fields', () => {
    expect(sanitizeNumericInput('12.5', false)).toBe('125');
  });
});

describe('NumberInput', () => {
  it('never lets an "e" reach the box or the state behind it', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const field = screen.getByLabelText('Size');

    await user.type(field, '12e5');

    expect(field).toHaveValue('125');
    expect(screen.getByRole('status')).toHaveTextContent('125');
  });

  it('keeps a half-typed decimal so the point can be typed at all', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const field = screen.getByLabelText('Size');

    await user.type(field, '1.');
    expect(field).toHaveValue('1.');

    await user.type(field, '5');
    expect(field).toHaveValue('1.5');
  });

  it('ignores a pasted value that is not a number', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const field = screen.getByLabelText('Size');

    await user.click(field);
    await user.paste('abc');

    expect(field).toHaveValue('');
  });

  it('takes digits from a mixed paste rather than dropping the lot', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const field = screen.getByLabelText('Size');

    await user.click(field);
    await user.paste('10 GB');

    expect(field).toHaveValue('10');
  });

  it('reports itself as a numeric field for on-screen keyboards', () => {
    render(<Controlled />);
    expect(screen.getByLabelText('Size')).toHaveAttribute('inputmode', 'decimal');
  });

  it('leaves the caret where it was when a character is rejected mid-edit', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="1234" />);
    const field = screen.getByLabelText('Size') as HTMLInputElement;

    field.setSelectionRange(2, 2);
    await user.type(field, 'e', { initialSelectionStart: 2, initialSelectionEnd: 2 });

    expect(field).toHaveValue('1234');
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
    expect(field.selectionStart).toBe(2);
  });
});
