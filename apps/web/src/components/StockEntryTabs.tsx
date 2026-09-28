/**
 * The bar that switches between the two ways stock is put right on the books:
 * a stock take (count what is there, post the difference) and opening stock
 * (bring on items the system does not have yet). Each person sees the ones
 * they may use.
 */

import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth.js';

const TABS = [
  { to: '/count', label: 'Stock take', permission: 'stock.adjust' },
  { to: '/opening-stock', label: 'Opening stock', permission: 'stock.opening' },
];

export function StockEntryTabs() {
  const { can } = useAuth();
  const tabs = TABS.filter((t) => can(t.permission));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Stock entry" className="no-print -mt-1 flex flex-wrap gap-1">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            `rounded-lg px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition ${
              isActive ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'
            }`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
