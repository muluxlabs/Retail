/**
 * The bar that switches between the buying screens. They share one top-level
 * "Buying" tab in the header, and each person sees only what they may use: a
 * goods receiver sees Goods received and Suppliers, finance sees Payments and
 * Owed as well.
 */

import { NavLink } from 'react-router-dom';

import { useAuth } from '../lib/auth.js';

interface Tab {
  to: string;
  label: string;
  /** Any one of these is enough. */
  any: string[];
  /** What the group owes and has paid is group-wide finance: hidden from someone tied to a branch. */
  groupWide?: boolean;
}

const TABS: Tab[] = [
  { to: '/suppliers', label: 'Suppliers', any: ['supplier.read'] },
  { to: '/orders', label: 'Orders', any: ['supplier.read'] },
  { to: '/receive', label: 'Goods received', any: ['grn.post', 'supplier.read'] },
  { to: '/returns', label: 'Returns', any: ['supplier.read'] },
  { to: '/payments', label: 'Payments', any: ['supplier.read'], groupWide: true },
  { to: '/owed', label: 'Owed to suppliers', any: ['supplier.read'], groupWide: true },
];

export function BuyingTabs() {
  const { user, can } = useAuth();
  const scoped = (user?.branchIds?.length ?? 0) > 0;
  const tabs = TABS.filter((t) => !(t.groupWide === true && scoped) && t.any.some(can));
  return (
    <nav aria-label="Buying" className="no-print -mt-1 flex flex-wrap gap-1">
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
