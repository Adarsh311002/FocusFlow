import { describe, expect, it } from 'vitest';

import { createClock, sampleFromRoundTrip } from './time-sync';

describe('sampleFromRoundTrip', () => {
  it('estimates the offset against the midpoint of the round trip', () => {
    // Sent at 1000, received at 1100: the server read its clock at ~1050 client time.
    expect(sampleFromRoundTrip(1_000, 5_050, 1_100)).toEqual({ offsetMs: 4_000, roundTripMs: 100 });
  });
});

describe('createClock', () => {
  it('reports no offset before the first sample', () => {
    const clock = createClock(() => 10_000);
    expect(clock.hasSamples()).toBe(false);
    expect(clock.offsetMs()).toBe(0);
    expect(clock.serverNow()).toBe(10_000);
  });

  it('trusts the sample with the shortest round trip', () => {
    const clock = createClock(() => 0);
    clock.addSample({ offsetMs: 4_200, roundTripMs: 400 });
    clock.addSample({ offsetMs: 4_010, roundTripMs: 20 });
    clock.addSample({ offsetMs: 3_900, roundTripMs: 250 });

    expect(clock.offsetMs()).toBe(4_010);
  });

  it('corrects a client clock that is far off (hours), because only the offset matters', () => {
    let clientNow = 1_000;
    const clock = createClock(() => clientNow);
    const threeHoursBehind = 3 * 60 * 60 * 1_000;
    const serverAtMidpoint = 1_050 + threeHoursBehind;

    clock.addSample(sampleFromRoundTrip(1_000, serverAtMidpoint, 1_100));
    clientNow = 2_000;

    expect(clock.serverNow()).toBe(2_000 + threeHoursBehind);
  });

  it('ignores a sample with a negative round trip (the client clock jumped back)', () => {
    const clock = createClock(() => 0);
    clock.addSample({ offsetMs: 100, roundTripMs: 30 });
    clock.addSample({ offsetMs: 999_999, roundTripMs: -5 });

    expect(clock.offsetMs()).toBe(100);
  });

  it('forgets old samples so a changed network is noticed', () => {
    const clock = createClock(() => 0);
    clock.addSample({ offsetMs: 1, roundTripMs: 1 });
    for (let index = 0; index < 8; index += 1) {
      clock.addSample({ offsetMs: 500, roundTripMs: 50 });
    }

    expect(clock.offsetMs()).toBe(500);
  });
});
