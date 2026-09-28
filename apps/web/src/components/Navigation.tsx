/**
 * Getting around: the short top bar, the all-screens panel (the nine dots, or
 * Ctrl+K) with search, and the optional side bar.
 *
 * Everything comes from lib/screens.ts, filtered by what the signed-in person
 * may open. Whether the menu sits at the top or on the side is a per-person,
 * per-device choice kept in this browser.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth.js';
import { AREAS, isIn, MAIN, SCREENS, searchScreens, type Screen } from '../lib/screens.js';

export type NavLayout = 'top' | 'side';

const LAYOUT_KEY = 'nav.layout';

export function useNavLayout(): [NavLayout, (l: NavLayout) => void] {
  const [layout, setLayout] = useState<NavLayout>(() => {
    try {
      return window.localStorage.getItem(LAYOUT_KEY) === 'side' ? 'side' : 'top';
    } catch {
      return 'top';
    }
  });
  const set = (l: NavLayout) => {
    setLayout(l);
    try {
      window.localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* private window: the choice lasts for this visit only */
    }
  };
  return [layout, set];
}

/** The screens this person may open. */
export function useMyScreens(): Screen[] {
  const { can, user } = useAuth();
  const scoped = (user?.branchIds ?? []).length > 0;
  return useMemo(
    () => SCREENS.filter((s) => (s.permission.length === 0 || s.permission.some(can)) && !(s.groupWide === true && scoped)),
    [can, scoped],
  );
}

function NineDots() {
  return (
    <svg viewBox="0 0 20 20" className="size-[18px]" aria-hidden="true">
      {[3, 10, 17].flatMap((y) => [3, 10, 17].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.9" fill="currentColor" />))}
    </svg>
  );
}

/** The short list in the top bar: the main areas this person works in. */
export function TopBar({ screens, max }: { screens: Screen[]; max: number }) {
  const location = useLocation();
  const mine = new Set(screens.map((s) => s.to));
  const items = MAIN.map((m) => ({ ...m, first: m.paths.find((p) => mine.has(p)) }))
    .filter((m): m is typeof m & { first: string } => m.first !== undefined)
    .slice(0, max);
  return (
    <nav aria-label="Main" className="hidden min-w-0 items-center gap-0.5 lg:flex">
      {items.map((m, i) => {
        const active = m.paths.some((p) => isIn(p, location.pathname));
        return (
          <NavLink
            key={m.label}
            to={m.first}
            // Below 1280px only the first six fit; the rest are one click away in the nine dots.
            className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition ${i >= 6 ? 'max-xl:hidden' : ''} ${
              active ? 'bg-ink-100 text-ink-900' : 'text-ink-500 hover:bg-ink-50 hover:text-ink-800'
            }`}
          >
            {m.label}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** The button that opens every screen. */
export function LauncherButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="All screens"
      title="All screens (Ctrl+K)"
      className="text-ink-500 hover:bg-ink-100 hover:text-ink-900 grid size-9 shrink-0 place-items-center rounded-lg transition"
      data-testid="launcher-button"
    >
      <NineDots />
    </button>
  );
}

/** Every screen, grouped by area, with search. Ctrl+K opens it from anywhere. */
export function Launcher({
  open,
  onClose,
  screens,
  layout,
  onLayout,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  screens: Screen[];
  layout: NavLayout;
  onLayout: (l: NavLayout) => void;
  onSignOut: () => void;
}) {
  const nav = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchScreens(screens, query), [screens, query]);
  const searching = query.trim() !== '';

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  const go = (s: Screen) => {
    onClose();
    if (s.to === '/docs') window.open('/docs', '_blank', 'noopener');
    else nav(s.to);
  };

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter' && results[cursor] !== undefined) {
      go(results[cursor]);
    }
  }

  const byArea = AREAS.map((a) => ({ area: a, items: screens.filter((s) => s.area === a) })).filter((g) => g.items.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 p-3 sm:p-6" onClick={onClose} role="dialog" aria-label="All screens">
      <div
        className="mt-[4vh] flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="border-ink-100 flex items-center gap-3 border-b px-4 py-3">
          <svg viewBox="0 0 20 20" className="text-ink-400 size-5 shrink-0" aria-hidden="true">
            <path fill="currentColor" d="M8.5 3a5.5 5.5 0 0 1 4.4 8.8l3.7 3.7-1.1 1.1-3.7-3.7A5.5 5.5 0 1 1 8.5 3zm0 1.6a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8z" />
          </svg>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search screens — e.g. price list, Z report, debtors, shift…"
            aria-label="Search screens"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
          <kbd className="text-ink-400 border-ink-200 hidden rounded border px-1.5 py-0.5 text-[11px] sm:block">Esc</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {searching ? (
            results.length === 0 ? (
              <p className="text-ink-400 px-2 py-6 text-center text-[13px]">No screen matches “{query}”.</p>
            ) : (
              <ul data-testid="launcher-results">
                {results.map((s, i) => (
                  <li key={s.to}>
                    <button
                      onClick={() => go(s)}
                      onMouseEnter={() => setCursor(i)}
                      className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left ${i === cursor ? 'bg-accent-50' : ''}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium">{s.label}</span>
                        <span className="text-ink-500 block truncate text-[12.5px]">{s.description}</span>
                      </span>
                      <span className="text-ink-400 shrink-0 text-[11.5px]">{s.area}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="launcher-areas">
              {byArea.map((g) => (
                <section key={g.area}>
                  <h3 className="text-ink-400 mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider">{g.area}</h3>
                  <ul>
                    {g.items.map((s) => (
                      <li key={s.to}>
                        <button
                          onClick={() => go(s)}
                          className={`hover:bg-ink-50 block w-full rounded-lg px-2 py-1.5 text-left ${isIn(s.to, location.pathname) ? 'bg-accent-50' : ''}`}
                        >
                          <span className="block text-[13.5px] font-medium">{s.label}</span>
                          <span className="text-ink-500 block text-[12px] leading-snug">{s.description}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        <div className="border-ink-100 bg-ink-50/60 flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-[12.5px]">
          <div className="hidden items-center gap-2 lg:flex">
            <span className="text-ink-500">Menu:</span>
            <div className="bg-ink-100 flex rounded-lg p-0.5" role="group" aria-label="Menu position">
              {(
                [
                  ['top', 'Across the top'],
                  ['side', 'Down the side'],
                ] as const
              ).map(([v, t]) => (
                <button
                  key={v}
                  onClick={() => onLayout(v)}
                  aria-pressed={layout === v}
                  className={`rounded-md px-2.5 py-1 font-medium ${layout === v ? 'text-ink-900 bg-white shadow-sm' : 'text-ink-500'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <span className="text-ink-400 hidden sm:inline">↑ ↓ to choose · Enter to open · Ctrl K from anywhere</span>
          <button onClick={onSignOut} className="text-ink-600 hover:text-ink-900 font-medium lg:hidden">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/** The side bar: every screen, grouped, always in view. */
export function SideBar({ screens }: { screens: Screen[] }) {
  const location = useLocation();
  const byArea = AREAS.map((a) => ({ area: a, items: screens.filter((s) => s.area === a && s.to !== '/docs') })).filter((g) => g.items.length > 0);
  return (
    <aside className="border-ink-200/80 sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto border-r bg-white/70 px-2.5 py-4 lg:block" aria-label="Menu">
      <nav className="space-y-4">
        {byArea.map((g) => (
          <div key={g.area}>
            {g.area !== 'Home' && <div className="text-ink-400 mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider">{g.area}</div>}
            {g.items.map((s) => {
              const active = isIn(s.to, location.pathname) || (s.alsoActive ?? []).some((p) => location.pathname.startsWith(p));
              return (
                <NavLink
                  key={s.to}
                  to={s.to}
                  className={`block rounded-lg px-2.5 py-1.5 text-[13px] font-medium ${active ? 'bg-ink-100 text-ink-900' : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900'}`}
                >
                  {s.label}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** Ctrl+K (or ⌘K) opens the all-screens panel from anywhere. */
export function useLauncherShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
