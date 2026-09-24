import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { useAuth } from './lib/auth.js';
import { Spinner } from './lib/ui.js';
import { Branches } from './pages/Branches.js';
import { Cash } from './pages/Cash.js';
import { Count } from './pages/Count.js';
import { Dashboard } from './pages/Dashboard.js';
import { Exceptions } from './pages/Exceptions.js';
import { Ledger } from './pages/Ledger.js';
import { ChangePassword, Login } from './pages/Login.js';
import { Products } from './pages/Products.js';
import { Receive } from './pages/Receive.js';
import { Sell } from './pages/Sell.js';
import { Settings } from './pages/Settings.js';
import { Stock } from './pages/Stock.js';
import { Transfers } from './pages/Transfers.js';
import { Users } from './pages/Users.js';

/**
 * Navigation is filtered by capability, so a cashier does not see a Stock tab
 * that would only 403. This is presentation: the API refuses on its own
 * authority regardless of what is rendered here.
 *
 * Sell and Receive lead, ahead of the read-only screens: they are what most
 * people who sign in actually do every day, and the exception queue exists
 * to catch what these two get wrong.
 */
const NAV = [
  { to: '/', label: 'Overview', end: true, permission: 'dashboard.read' },
  { to: '/sell', label: 'Sell', permission: 'movement.post' },
  { to: '/receive', label: 'Receive', permission: 'movement.post' },
  { to: '/count', label: 'Count', permission: 'stock.adjust' },
  { to: '/transfers', label: 'Transfers', permission: 'transfer.read' },
  // A cashier holds only cash.count, finance/auditor only cash.read - no
  // single permission covers everyone who should see this tab, so it takes
  // any-of. The page itself still decides what each of them can actually do.
  { to: '/cash', label: 'Cash', permission: ['cash.read', 'cash.count', 'cash.move'] },
  { to: '/exceptions', label: 'Exceptions', permission: 'exception.read' },
  { to: '/stock', label: 'Stock', permission: 'stock.read' },
  { to: '/products', label: 'Item master', permission: 'product.read' },
  { to: '/ledger', label: 'Ledger', permission: 'stock.read' },
  { to: '/users', label: 'Staff', permission: 'user.read' },
  { to: '/branches', label: 'Branches', permission: 'branch.manage' },
  { to: '/settings', label: 'Settings', permission: 'settings.manage' },
];

function canAny(can: (p: string) => boolean, permission: string | string[]): boolean {
  return Array.isArray(permission) ? permission.some(can) : can(permission);
}

export function App() {
  const { user, loading, can } = useAuth();

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }

  if (user === null) return <Login />;

  // A seeded or reset password blocks everything else. The API enforces this
  // too; this is the matching wall in the UI rather than a suggestion.
  if (user.mustChangePassword) return <ChangePassword />;

  const visible = NAV.filter((item) => canAny(can, item.permission));
  // Land people on the first screen they are actually allowed to see.
  const home = visible[0]?.to ?? '/products';

  return (
    <div className="flex h-full flex-col">
      <header className="border-ink-200/80 sticky top-0 z-20 border-b bg-white/85 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-6 px-5">
          <div className="flex items-center gap-2.5">
            <div className="bg-accent-600 grid size-7 place-items-center rounded-md">
              <svg viewBox="0 0 24 24" className="size-4 text-white" aria-hidden="true">
                <path fill="currentColor" d="M4 7h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm12-4h4v2h-4z" />
              </svg>
            </div>
            <div className="leading-none">
              <div className="text-[13px] font-semibold tracking-tight">Retail Operations</div>
              <div className="text-ink-400 mt-0.5 text-[10.5px]">Multi-branch control</div>
            </div>
          </div>

          <nav className="flex items-center gap-0.5">
            {visible.map((item) => (
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

          <div className="ml-auto">
            <UserMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-5 py-6">
        <Routes>
          <Route path="/" element={can('dashboard.read') ? <Dashboard /> : <Navigate to={home} replace />} />
          <Route path="/sell" element={<Guard permission="movement.post" home={home}><Sell /></Guard>} />
          <Route path="/receive" element={<Guard permission="movement.post" home={home}><Receive /></Guard>} />
          <Route path="/count" element={<Guard permission="stock.adjust" home={home}><Count /></Guard>} />
          <Route path="/transfers" element={<Guard permission="transfer.read" home={home}><Transfers /></Guard>} />
          <Route
            path="/cash"
            element={
              <Guard permission={['cash.read', 'cash.count', 'cash.move']} home={home}>
                <Cash />
              </Guard>
            }
          />
          <Route path="/exceptions" element={<Guard permission="exception.read" home={home}><Exceptions /></Guard>} />
          <Route path="/stock" element={<Guard permission="stock.read" home={home}><Stock /></Guard>} />
          <Route path="/products" element={<Guard permission="product.read" home={home}><Products /></Guard>} />
          <Route path="/ledger" element={<Guard permission="stock.read" home={home}><Ledger /></Guard>} />
          <Route path="/users" element={<Guard permission="user.read" home={home}><Users /></Guard>} />
          <Route path="/branches" element={<Guard permission="branch.manage" home={home}><Branches /></Guard>} />
          <Route path="/settings" element={<Guard permission="settings.manage" home={home}><Settings /></Guard>} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Guard({
  permission,
  home,
  children,
}: {
  permission: string | string[];
  home: string;
  children: React.ReactNode;
}) {
  const { can } = useAuth();
  if (!canAny(can, permission)) return <Navigate to={home} replace />;
  return <>{children}</>;
}

function UserMenu() {
  const { user, signOut } = useAuth();
  if (user === null) return null;

  const initials = user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <div className="flex items-center gap-2.5">
      <div className="hidden text-right sm:block">
        <div className="text-[12px] font-medium leading-tight">{user.fullName}</div>
        <div className="text-ink-400 text-[10.5px] leading-tight">
          {user.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}
        </div>
      </div>
      <div className="bg-ink-200 text-ink-700 grid size-7 place-items-center rounded-full text-[10.5px] font-semibold">
        {initials}
      </div>
      <button
        onClick={() => void signOut()}
        className="text-ink-400 hover:text-ink-800 hover:bg-ink-100 rounded-lg px-2 py-1.5 text-[12px] font-medium transition"
      >
        Sign out
      </button>
    </div>
  );
}
