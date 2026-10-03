import { describe, expect, it } from 'vitest';

import { splitEntry } from './store.js';

describe('splitEntry', () => {
  it('splits on the first colon', () => {
    expect(splitEntry('01a0ed0d-55de-7d1b-8495-82fb5050d815:Ab_c-12')).toEqual([
      '01a0ed0d-55de-7d1b-8495-82fb5050d815',
      'Ab_c-12',
    ]);
  });

  it.each(['no-colon', ':leading', 'trailing:', ''])('rejects the malformed entry %j', (entry) => {
    expect(splitEntry(entry)).toBeUndefined();
  });
});
