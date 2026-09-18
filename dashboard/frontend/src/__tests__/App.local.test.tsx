import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';

vi.mock('../components/LocalVideoWorkspace', () => ({ default: () => <main>VisionEcho 工作台</main> }));
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const scrollIntoView = vi.fn();
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  scrollIntoView.mockClear();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mode: 'local', user: null, limits: { max_video_seconds: 600, max_upload_mb: 500 } }) }));
});
afterEach(() => {
  cleanup(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

it.each([undefined, 'false', 'true'])('opens the overview before the workspace with legacy mode=%s', async value => {
  vi.stubEnv('VITE_LOCAL_BACKEND', value);
  render(<App />);
  const overview = await screen.findByRole('main');
  expect(within(overview).getByRole('heading', { level: 1 })).toHaveTextContent('让画面被听见。');
  expect(screen.getByText('VisionEcho 工作台')).not.toBeVisible();
  fireEvent.click(within(overview).getAllByRole('button', { name: '进入工作区' })[0]);
  expect(screen.getByRole('main')).toHaveTextContent('VisionEcho 工作台');
  expect(window.location.hash).toBe('#visionecho-content');
  expect(fetch).toHaveBeenCalledOnce();
});

it('opens the overview at the top for a direct about link', async () => {
  window.history.replaceState(null, '', '/#about');
  render(<App />);
  expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('让画面被听见。');
  expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' });
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(screen.getByText('VisionEcho 工作台')).not.toBeVisible();
});

it('positions a direct features link after the overview content mounts', async () => {
  window.history.replaceState(null, '', '/#features');
  render(<App />);
  await screen.findByRole('heading', { name: '从看见，到说清楚。' });
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
  expect(scrollIntoView.mock.contexts).toContain(document.getElementById('features'));
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(screen.getByText('VisionEcho 工作台')).not.toBeVisible();
});
