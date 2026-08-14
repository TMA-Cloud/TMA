import React from 'react';
import { sanitizeNumericInput } from '../../utils/numberInput';

export interface NumberInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange'
> {
  /** The field is controlled as a string so a half-typed "1." survives editing. */
  value: string;
  onValueChange: (value: string) => void;
  /** Whether a single decimal point is allowed. Whole-number fields pass false. */
  decimal?: boolean;
}

/**
 * A field that accepts digits and nothing else.
 *
 * `<input type="number">` is the obvious choice and is the reason this exists.
 * Browsers accept `e`, `E`, `+` and `-` into it, since a floating-point literal
 * can contain them, but while the box holds something like `12e` the element
 * reports its value as the empty string. A controlled field then stores '',
 * re-renders with '', and the DOM — already '' as far as it is concerned —
 * leaves `12e` on screen. The character sticks, any sanitiser downstream is
 * handed an empty string it has nothing to clean, and saving fails complaining
 * about an empty field that visibly has something in it.
 *
 * A text input reports exactly what was typed, so filtering here keeps the
 * stored value and the visible one the same string. It also brings back
 * `maxLength`, which the number type ignores.
 */
export const NumberInput: React.FC<NumberInputProps> = ({
  value,
  onValueChange,
  decimal = true,
  autoComplete = 'off',
  ...rest
}) => {
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const element = event.currentTarget;
    const raw = element.value;
    const cleaned = sanitizeNumericInput(raw, decimal);

    if (cleaned !== raw) {
      // Rewriting the value moves the caret to the end, which is invisible when
      // the rejected character was typed there and maddening when it was not.
      // Counting the characters that survived ahead of it puts it back.
      const caret = sanitizeNumericInput(raw.slice(0, element.selectionStart ?? raw.length), decimal).length;
      requestAnimationFrame(() => {
        if (document.activeElement === element) element.setSelectionRange(caret, caret);
      });
    }

    onValueChange(cleaned);
  };

  return (
    <input
      autoComplete={autoComplete}
      {...rest}
      type="text"
      inputMode={decimal ? 'decimal' : 'numeric'}
      value={value}
      onChange={handleChange}
    />
  );
};
