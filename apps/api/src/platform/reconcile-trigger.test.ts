import { describe, expect, it } from 'vitest';

import {
  isReconcileOverdue,
  RECONCILE_LIVENESS_FACTOR,
  reconcileOverdueAfterMs,
} from './reconcile-trigger.js';

// E23: scheduled reconcile runs count as stopped after 3 × RECONCILER_INTERVAL_MS without a
// finished run; then every worker process reconciles directly.

describe('reconcile liveness threshold (E23)', () => {
  it('is three intervals: 90 s with the default 30 s interval', () => {
    expect(RECONCILE_LIVENESS_FACTOR).toBe(3);
    expect(reconcileOverdueAfterMs(30_000)).toBe(90_000);
    expect(reconcileOverdueAfterMs(500)).toBe(1_500);
  });

  it('is overdue with no record, and from exactly three intervals on', () => {
    const now = 1_791_000_000_000;
    expect(isReconcileOverdue(undefined, now, 30_000)).toBe(true);
    expect(isReconcileOverdue(now, now, 30_000)).toBe(false);
    expect(isReconcileOverdue(now - 89_999, now, 30_000)).toBe(false);
    expect(isReconcileOverdue(now - 90_000, now, 30_000)).toBe(true);
    expect(isReconcileOverdue(now - 3_600_000, now, 30_000)).toBe(true);
  });
});
