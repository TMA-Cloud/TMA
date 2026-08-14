/**
 * Filtering for fields that take a plain number.
 *
 * Kept apart from the NumberInput component that uses it so the rule can be
 * tested and reused as a function — the save handlers that receive these
 * values have the same idea of what counts as a number.
 */

/**
 * Strips everything that is not part of a plain decimal number.
 *
 * Only the first decimal point survives, and the digits after a second one are
 * kept rather than dropped: a stray separator is far more often a slip than a
 * signal that the rest of the number was unwanted.
 */
export function sanitizeNumericInput(raw: string, decimal = true): string {
  const stripped = raw.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, '');
  if (!decimal) return stripped;
  const [head = '', ...rest] = stripped.split('.');
  return rest.length > 0 ? `${head}.${rest.join('')}` : head;
}
