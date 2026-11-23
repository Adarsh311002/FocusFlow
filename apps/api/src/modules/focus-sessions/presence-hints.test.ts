import { describe, expect, it } from 'vitest';

import { evidenceFor } from './presence-hints.js';

// E10: the evidence a presence hint carries. Only a socket's own disconnect is observed;
// every other source reports a detection time, which can start a grace but never prove
// presence through the planned end.

describe('evidenceFor', () => {
  it('marks only a socket’s own disconnect as observed', () => {
    expect(evidenceFor('disconnect')).toBe('observed');
  });

  it.each(['missed_disconnect', 'instance_dead', 'instance_shutdown'] as const)(
    'marks %s as detected',
    (reason) => {
      expect(evidenceFor(reason)).toBe('detected');
    },
  );
});
