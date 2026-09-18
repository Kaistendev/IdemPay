import { canonicalizePayload, hashCanonicalPayload } from './payload-hash';

describe('canonicalizePayload', () => {
  it('produces a deterministic serialization', () => {
    expect(canonicalizePayload({ amount: 100, currency: 'USD' })).toBe(
      '{"amount":100,"currency":"USD"}',
    );
  });

  it('ignores property order, including nested objects', () => {
    expect(canonicalizePayload({ b: 2, a: 1 })).toBe(
      canonicalizePayload({ a: 1, b: 2 }),
    );
    expect(canonicalizePayload({ outer: { b: 2, a: 1 } })).toBe(
      canonicalizePayload({ outer: { a: 1, b: 2 } }),
    );
  });

  it('ignores insignificant whitespace in strings', () => {
    expect(canonicalizePayload({ note: '  hello   world  ' })).toBe(
      canonicalizePayload({ note: 'hello world' }),
    );
  });

  it('normalizes numeric strings to numbers', () => {
    expect(canonicalizePayload({ amount: '100' })).toBe(
      canonicalizePayload({ amount: 100 }),
    );
    expect(canonicalizePayload({ amount: '10.50' })).toBe(
      canonicalizePayload({ amount: 10.5 }),
    );
  });

  it('keeps strings that are not canonical numbers as strings', () => {
    expect(canonicalizePayload({ code: '007' })).toBe('{"code":"007"}');
    expect(canonicalizePayload({ code: 'USD' })).toBe('{"code":"USD"}');
    expect(canonicalizePayload({ code: '1e3' })).toBe('{"code":"1e3"}');
  });

  it('keeps array order significant', () => {
    expect(canonicalizePayload({ ids: [1, 2] })).not.toBe(
      canonicalizePayload({ ids: [2, 1] }),
    );
  });

  it('omits undefined properties', () => {
    expect(canonicalizePayload({ a: 1, b: undefined })).toBe(
      canonicalizePayload({ a: 1 }),
    );
  });

  it('serializes dates as ISO strings', () => {
    expect(
      canonicalizePayload({ at: new Date('2026-09-17T00:00:00.000Z') }),
    ).toBe('{"at":"2026-09-17T00:00:00.000Z"}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalizePayload({ amount: Number.NaN })).toThrow(
      'Unsupported payload value',
    );
    expect(() =>
      canonicalizePayload({ amount: Number.POSITIVE_INFINITY }),
    ).toThrow('Unsupported payload value');
  });

  it('rejects values outside the JSON domain', () => {
    expect(() => canonicalizePayload({ fn: () => undefined })).toThrow(
      'Unsupported payload value',
    );
    expect(() => canonicalizePayload({ map: new Map() })).toThrow(
      'Unsupported payload value',
    );
  });
});

describe('hashCanonicalPayload', () => {
  it('is stable for canonically equivalent payloads', () => {
    expect(hashCanonicalPayload({ amount: 100, currency: 'USD' })).toBe(
      hashCanonicalPayload({ currency: ' USD ', amount: '100' }),
    );
  });

  it('treats a changed amount as a different payload', () => {
    expect(hashCanonicalPayload({ amount: 100 })).not.toBe(
      hashCanonicalPayload({ amount: 101 }),
    );
  });

  it('produces a sha256 hex digest', () => {
    expect(hashCanonicalPayload({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
