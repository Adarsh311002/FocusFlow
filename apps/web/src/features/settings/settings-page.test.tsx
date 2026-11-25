import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parsedBody, type RecordedRequest, stubFetch } from '../../test/api-stub';
import { createFakeTaskApi } from '../../test/fake-task-api';
import { createTestQueryClient } from '../../test/query-client';
import { ThemeProvider } from '../../ui/theme';
import { resetPendingRefresh } from '../auth/auth-client';
import { AuthProvider } from '../auth/auth-context';
import { clearAccessToken } from '../auth/token-store';
import { avatarGlyph, SettingsPage } from './settings-page';

// Settings (ST1–ST4).

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
  resetPendingRefresh();
});

const patches = (calls: RecordedRequest[]) =>
  calls.filter((call) => call.method === 'PATCH').map((call) => parsedBody(call));

function renderSettings() {
  const api = createFakeTaskApi();
  const calls = stubFetch((request) => api.handle(request));
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <AuthProvider>
        <ThemeProvider>
          <SettingsPage />
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

describe('avatarGlyph', () => {
  it('shows the chosen animal, or the initial', () => {
    expect(avatarGlyph({ displayName: 'ada', avatarPreset: 'sloth' })).toBe('🦥');
    expect(avatarGlyph({ displayName: 'ada', avatarPreset: null })).toBe('A');
    expect(avatarGlyph({ displayName: 'ada' })).toBe('A');
  });
});

describe('the settings page', () => {
  it('renames the user, trimmed by the server', async () => {
    const { calls } = renderSettings();
    const name = await screen.findByLabelText('Display name');
    fireEvent.change(name, { target: { value: '  Grace  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByText('Saved.')).not.toBeNull();
    expect(patches(calls)).toEqual([{ displayName: '  Grace  ' }]);
  });

  it('chooses a forest companion and goes back to the initial', async () => {
    const { calls } = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Owl' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Owl' }).getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Just my initial' }));
    await waitFor(() => {
      expect(patches(calls)).toEqual([{ avatarPreset: 'owl' }, { avatarPreset: null }]);
    });
  });

  it('sets the default session length from a preset or in whole minutes', async () => {
    const { calls } = renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: '50 min' }));
    fireEvent.change(screen.getByLabelText('Other length in minutes (1–240)'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => {
      expect(patches(calls)).toEqual([
        { defaultSessionSeconds: 3000 },
        { defaultSessionSeconds: 2400 },
      ]);
    });
  });
});
