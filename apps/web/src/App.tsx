import { NavLink, Route, Routes } from 'react-router-dom';

import { Dashboard } from './pages/Dashboard.js';
import { Exceptions } from './pages/Exceptions.js';
import { Ledger } from './pages/Ledger.js';
import { Products } from './pages/Products.js';
import { Stock } from './pages/Stock.js';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/exceptions', label: 'Exceptions' },
  { to: '/stock', label: 'Stock' },
  { to: '/products', label: 'Item master' },
  { to: '/ledger', label: 'Ledger' },
];

export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-ink-200/80 sticky top-0 z-20 border-b bg-white/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-6 px-5">
          <div className="flex items-center gap-2.5">
            <div className="bg-accent-600 grid size-7 place-items-center rounded-md">
              <svg viewBox="0 0 24 24" className="size-4 text-white" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M4 7h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm12-4h4v2h-4z"
                />
              </svg>
            </div>
            <div className="leading-none">
              <div className="text-[13px] font-semibold tracking-tight">Retail Operations</div>
              <div className="text-ink-400 mt-0.5 text-[10.5px]">Multi-branch control</div>
            </div>
          </div>

          <nav className="flex items-center gap-0.5">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end ?? false}
                className={({ isActive }) =>
                  `rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition ${
                    isActive
                      ? 'bg-ink-100 text-ink-900'
                      : 'text-ink-500 hover:text-ink-800 hover:bg-ink-50'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/exceptions" element={<Exceptions />} />
          <Route path="/stock" element={<Stock />} />
          <Route path="/products" element={<Products />} />
          <Route path="/ledger" element={<Ledger />} />
        </Routes>
      </main>
    </div>
  );
}
