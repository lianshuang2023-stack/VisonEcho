import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLandingMotion } from './useLandingMotion';

function Probe({ enabled = true }: { enabled?: boolean }) {
  const root = useLandingMotion(enabled);
  return <div ref={root} data-testid="root"><section data-reveal>Readable scene</section></div>;
}

class Observer {
  static instances: Observer[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    Observer.instances.push(this);
  }
  show(target: Element) {
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function motionPreference(reduced = false) {
  const listeners = new Set<() => void>();
  const preference = {
    matches: reduced,
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => preference));
  return { preference, change(value: boolean) { preference.matches = value; listeners.forEach(listener => listener()); } };
}

beforeEach(() => {
  Observer.instances = [];
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 1200, bottom: 1500, left: 0, right: 500, width: 500, height: 300, x: 0, y: 1200, toJSON: () => ({}),
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('landing motion accessibility', () => {
  it('keeps sections readable with OS reduced motion and reacts to live changes', () => {
    const os = motionPreference(true);
    render(<Probe />);
    expect(screen.getByTestId('root')).toHaveAttribute('data-motion', 'off');
    expect(screen.getByText('Readable scene')).toBeVisible();
    expect(screen.getByText('Readable scene')).toHaveAttribute('data-reveal-state', 'shown');
    expect(Observer.instances).toHaveLength(0);
    act(() => os.change(false));
    expect(screen.getByTestId('root')).toHaveAttribute('data-motion', 'on');
    expect(screen.getByText('Readable scene')).toHaveAttribute('data-revealed', 'true');
    act(() => os.change(true));
    expect(screen.getByTestId('root')).toHaveAttribute('data-motion', 'off');
    expect(Observer.instances[0].disconnect).toHaveBeenCalled();
  });

  it('disconnects and shows remaining sections when the user pauses motion', () => {
    motionPreference();
    const view = render(<Probe />);
    const section = screen.getByText('Readable scene');
    expect(section).toHaveAttribute('data-reveal-state', 'pending');
    expect(section).toBeVisible();
    const observer = Observer.instances[0];
    view.rerender(<Probe enabled={false} />);
    expect(observer.disconnect).toHaveBeenCalled();
    expect(screen.getByTestId('root')).toHaveAttribute('data-motion', 'off');
    expect(section).toHaveAttribute('data-reveal-state', 'shown');
  });

  it.each(['missing', 'throws', 'observer'] as const)('shows content when browser support is %s', support => {
    motionPreference();
    if (support === 'missing') vi.stubGlobal('matchMedia', undefined);
    if (support === 'throws') vi.stubGlobal('matchMedia', () => { throw new Error('Unavailable'); });
    if (support === 'observer') vi.stubGlobal('IntersectionObserver', undefined);
    render(<Probe />);
    expect(screen.getByTestId('root')).toHaveAttribute('data-motion', 'off');
    expect(screen.getByText('Readable scene')).toHaveAttribute('data-reveal-state', 'shown');
    expect(screen.getByText('Readable scene')).toBeVisible();
  });

  it('reveals a section once and removes observers and media listeners on cleanup', () => {
    const os = motionPreference();
    const removeVisibility = vi.spyOn(document, 'removeEventListener');
    const view = render(<StrictMode><Probe /></StrictMode>);
    const observer = Observer.instances.at(-1)!;
    const section = screen.getByText('Readable scene');
    expect(observer.observe).toHaveBeenCalledWith(section);
    expect(section).toHaveAttribute('data-reveal-state', 'pending');
    act(() => observer.show(section));
    expect(section).toHaveAttribute('data-reveal-state', 'shown');
    expect(observer.unobserve).toHaveBeenCalledWith(section);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(Observer.instances.at(-1)!.observe).not.toHaveBeenCalled();
    view.unmount();
    expect(Observer.instances.every(instance => instance.disconnect.mock.calls.length > 0)).toBe(true);
    expect(os.preference.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(removeVisibility).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('pauses while the document is hidden without hiding page content', () => {
    motionPreference();
    render(<Probe />);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByTestId('root')).toHaveAttribute('data-motion', 'off');
    expect(screen.getByText('Readable scene')).toHaveAttribute('data-reveal-state', 'shown');
    expect(screen.getByText('Readable scene')).toBeVisible();
  });
});
