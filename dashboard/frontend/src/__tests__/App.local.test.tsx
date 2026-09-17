import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../App';

vi.mock('../components/LocalVideoWorkspace', () => ({ default: () => <main>VisionEcho 工作台</main> }));
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([undefined, 'false', 'true'])('opens the workspace with legacy mode=%s', value => {
  vi.stubEnv('VITE_LOCAL_BACKEND', value);
  render(<App />);
  expect(screen.getByRole('main')).toHaveTextContent('VisionEcho 工作台');
  expect(fetch).not.toHaveBeenCalled();
});
