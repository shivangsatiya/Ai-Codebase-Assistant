import { useState, useEffect } from 'react';

/**
 * A real, standard matchMedia-based hook - not a resize-event listener
 * re-measuring window.innerWidth on every pixel of drag, which is both
 * less efficient and less semantically correct than asking the browser
 * directly whether a media query currently matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);

    // addEventListener over the older addListener - this project
    // targets modern evergreen browsers throughout (see package.json's
    // own browserslist-free reliance on Vite's current defaults), so
    // there's no real Safari-14-or-older audience to accommodate here.
    mediaQueryList.addEventListener('change', listener);
    return () => mediaQueryList.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

/**
 * Matches Tailwind's own default `md` breakpoint (768px) exactly -
 * deliberately, so a component's JS-driven behavior (e.g. "am I on the
 * mobile single-panel layout right now?") can never disagree with what
 * Tailwind's `md:` CSS classes are actually doing on screen at the same
 * moment. If this project's Tailwind breakpoints are ever customized in
 * the future, this constant needs to be updated to match - there's no
 * automatic way to read a Tailwind breakpoint value back out from CSS
 * into JavaScript.
 */
export function useIsMobileLayout(): boolean {
  return !useMediaQuery('(min-width: 768px)');
}
