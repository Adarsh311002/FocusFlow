import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The dashboard renders many pieces at once (the clearing, the daily intention, insights,
// tasks); under a parallel test run in jsdom its first render can take more than the
// default 1 s that `findBy*` waits. Waiting a little longer changes no assertion.
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
});
