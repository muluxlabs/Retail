/**
 * The bar that switches between cash custody, cashier shifts and closing the day. Each person
 * sees the ones they may use.
 */

import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth.js';

const TABS = [
  { to: '/cash', label: 'Cash custody', any: ['cash.read', 'cash.count', 'cash.move'] },
  { to: '/shifts', label: 'Shifts', any: ['shift.manage', 'sale.read'] },
  { to: '/day-close', label: 'End of day', any: ['day.close', 'sale.read'] },
];

export function CashTabs() {
  const { can } = useAuth();
  const tabs = TABS.filter((t) => t.any.some(can));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Cash" className="no-print -mt-1 flex flex-wrap gap-1">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/cash'}
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
