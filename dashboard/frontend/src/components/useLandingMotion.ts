import { useEffect, useRef } from 'react';

/**
 * Attach the returned ref to the landing-page root. The hook only annotates DOM:
 * root[data-motion="on"|"off"] and [data-reveal][data-reveal-state="pending"|"shown"].
 * A revealed target also gets data-revealed="true" and is never reset to pending.
 * CSS must keep unannotated/pending content readable; reveal is an enhancement,
 * not a prerequisite for seeing the page. Parallax remains entirely in CSS.
 */
export function useLandingMotion(enabled = true) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    let observer: IntersectionObserver | undefined;
    let preference: MediaQueryList | undefined;
    let disposed = false;

    const show = (element: HTMLElement) => {
      element.dataset.revealState = 'shown';
      element.dataset.revealed = 'true';
    };
    const stop = () => {
      observer?.disconnect();
      observer = undefined;
    };
    const staticPage = () => {
      root.dataset.motion = 'off';
      stop();
      targets.forEach(show);
    };

    try {
      preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    } catch {
      // A restricted browser environment should still show the complete page.
    }

    const synchronize = () => {
      if (disposed) return;
      stop();
      if (!enabled || !preference || preference.matches || document.hidden
        || typeof window.IntersectionObserver !== 'function') {
        staticPage();
        return;
      }

      try {
        observer = new IntersectionObserver((entries) => {
          if (disposed) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            show(entry.target as HTMLElement);
            observer?.unobserve(entry.target);
          }
        }, { threshold: 0, rootMargin: '0px 0px -24px 0px' });

        root.dataset.motion = 'on';
        for (const element of targets) {
          if (element.dataset.revealed === 'true') {
            show(element);
            continue;
          }
          // Content already on screen (including a restored scroll position)
          // is shown immediately instead of flashing away during hydration.
          const bounds = element.getBoundingClientRect();
          if (bounds.top < window.innerHeight || bounds.height === 0) {
            show(element);
          } else {
            observer.observe(element);
            element.dataset.revealState = 'pending';
          }
        }
      } catch {
        staticPage();
      }
    };

    const visibilityChanged = () => synchronize();
    let removePreferenceListener = () => {};
    try {
      if (preference?.addEventListener) {
        preference.addEventListener('change', synchronize);
        removePreferenceListener = () => preference?.removeEventListener('change', synchronize);
      } else if (preference?.addListener) {
        preference.addListener(synchronize);
        removePreferenceListener = () => preference?.removeListener(synchronize);
      }
      document.addEventListener('visibilitychange', visibilityChanged);
      synchronize();
    } catch {
      staticPage();
    }

    return () => {
      disposed = true;
      stop();
      removePreferenceListener();
      document.removeEventListener('visibilitychange', visibilityChanged);
      root.dataset.motion = 'off';
      for (const element of targets) {
        // Unannotated content is visible by default. Preserve completed reveals
        // but let React's development effect replay observe pending ones again.
        if (element.dataset.revealed !== 'true') delete element.dataset.revealState;
      }
    };
  }, [enabled]);

  return rootRef;
}
