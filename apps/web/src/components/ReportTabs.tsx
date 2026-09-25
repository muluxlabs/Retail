/**
 * The bar that switches between the report screens. They share one top-level
 * "Reports" tab in the header (there are too many screens to give each its own),
 * and each screen shows only the reports the person is allowed to see.
 */

import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth.js';

const TABS = [
  { to: '/profit', label: 'Sales and profit', permission: 'sale.read' },
  { to: '/items', label: 'Item analysis', permission: 'sale.read' },
  { to: '/sales', label: 'Receipts', permission: 'sale.read' },
  { to: '/reports', label: 'Stock movement', permission: 'stock.read' },
] as const;

export function ReportTabs() {
  const { can } = useAuth();
  const tabs = TABS.filter((t) => can(t.permission));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Reports" className="no-print -mt-1 flex flex-wrap gap-1">
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
