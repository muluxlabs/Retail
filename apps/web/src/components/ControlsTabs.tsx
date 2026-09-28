/**
 * The bar that switches between the exception queue (unusual events waiting
 * for a decision) and the audit log (the complete history of changes).
 */

import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth.js';

const TABS = [
  { to: '/exceptions', label: 'Exception queue', permission: 'exception.read' },
  { to: '/audit', label: 'Audit log', permission: 'audit.read' },
];

export function ControlsTabs() {
  const { can } = useAuth();
  const tabs = TABS.filter((t) => can(t.permission));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Controls" className="no-print -mt-1 flex flex-wrap gap-1">
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
