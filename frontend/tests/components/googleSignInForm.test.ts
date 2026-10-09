import { describe, expect, it } from 'vitest';

import { redirectUriFor } from '../../src/components/settings/sections/googleSignInForm';

describe('redirectUriFor', () => {
  it('appends the callback path to the site origin', () => {
    expect(redirectUriFor('https://cloud.example.com')).toBe('https://cloud.example.com/api/google/callback');
    expect(redirectUriFor('http://localhost:5173/')).toBe('http://localhost:5173/api/google/callback');
  });
});
