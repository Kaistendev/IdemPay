import { mapZodIssues } from './map-zod-issues';

describe('mapZodIssues', () => {
  it('maps nested paths joined by dots', () => {
    const details = mapZodIssues([
      { path: ['amount'], code: 'invalid_type', message: 'Expected number' },
      {
        path: ['customer', 'email'],
        code: 'invalid_string',
        message: 'Invalid email',
      },
    ]);

    expect(details).toEqual([
      { path: 'amount', code: 'invalid_type', message: 'Expected number' },
      {
        path: 'customer.email',
        code: 'invalid_string',
        message: 'Invalid email',
      },
    ]);
  });

  it('maps an empty path to an empty string', () => {
    expect(
      mapZodIssues([{ path: [], code: 'custom', message: 'bad payload' }]),
    ).toEqual([{ path: '', code: 'custom', message: 'bad payload' }]);
  });

  it('coerces non-string path segments to strings', () => {
    expect(
      mapZodIssues([
        { path: ['items', 2], code: 'custom', message: 'bad item' },
      ]),
    ).toEqual([{ path: 'items.2', code: 'custom', message: 'bad item' }]);
  });
});
