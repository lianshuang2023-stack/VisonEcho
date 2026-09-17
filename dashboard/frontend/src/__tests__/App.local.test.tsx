import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../App';

vi.mock('../components/LocalVideoWorkspace', () => ({ default: () => <main>VisionEcho 工作台</main> }));
beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mode: 'local', user: null, limits: { max_video_seconds: 600, max_upload_mb: 500 } }) })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([undefined, 'false', 'true'])('opens the workspace with legacy mode=%s', async value => {
  vi.stubEnv('VITE_LOCAL_BACKEND', value);
  render(<App />);
  expect(await screen.findByRole('main')).toHaveTextContent('VisionEcho 工作台');
  expect(fetch).toHaveBeenCalledOnce();
});
