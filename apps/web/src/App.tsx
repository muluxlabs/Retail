import { lazy, Suspense, useCallback, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { Launcher, LauncherButton, SideBar, TopBar, useLauncherShortcut, useMyScreens, useNavLayout } from './components/Navigation.js';

import { useAuth } from './lib/auth.js';
import { Spinner } from './lib/ui.js';
import { Branches } from './pages/Branches.js';
import { Cash } from './pages/Cash.js';
import { Count } from './pages/Count.js';
import { Dashboard } from './pages/Dashboard.js';
import { Exceptions } from './pages/Exceptions.js';
import { Items } from './pages/Items.js';
import { Ledger } from './pages/Ledger.js';
import { ChangePassword, Login } from './pages/Login.js';
import { NewOrder, Orders } from './pages/Orders.js';
import { OpeningStock, OpeningStockDetail } from './pages/OpeningStock.js';
import { NewReturn, ReturnDetailPage, Returns } from './pages/Returns.js';
import { NewPriceList, PriceListDetailPage, PriceLists } from './pages/PriceLists.js';
import { DayClose, ZReportPage } from './pages/DayClose.js';
import { ShiftReportPage, Shifts } from './pages/Shifts.js';
import { CustomerDetailPage, Customers, DebtorsPage } from './pages/Customers.js';
import { OrderDetail } from './pages/OrderDetail.js';
import { Owed } from './pages/Owed.js';
import { Payments } from './pages/Payments.js';
import { ReceiveDetail } from './pages/ReceiveDetail.js';
import { SupplierDetail } from './pages/SupplierDetail.js';
import { Suppliers } from './pages/Suppliers.js';
import { Prices } from './pages/Prices.js';
import { Profit } from './pages/Profit.js';
import { Products } from './pages/Products.js';
import { Receive } from './pages/Receive.js';
import { Reports } from './pages/Reports.js';
import { Sales } from './pages/Sales.js';
import { Sell } from './pages/Sell.js';
import { Settings } from './pages/Settings.js';
import { Stock } from './pages/Stock.js';
import { Transfers } from './pages/Transfers.js';
import { UserAccessPage } from './pages/UserAccess.js';
import { Audit } from './pages/Audit.js';
import { Exports } from './pages/Exports.js';
import { Reorder } from './pages/Reorder.js';
import { ItemImport } from './pages/ItemImport.js';
import { RecordImport } from './pages/RecordImport.js';
import { Users } from './pages/Users.js';

// The guide is its own bundle: the till never loads it.
const Docs = lazy(() => import('./pages/Docs.js').then((m) => ({ default: m.Docs })));

/**
 * Navigation is filtered by capability, so nobody sees a screen that would only
 * refuse them. This is presentation: the API refuses on its own authority
 * regardless of what is rendered here. The list of screens lives in
 * lib/screens.ts; components/Navigation.tsx draws the top bar, the all-screens
 * panel and the side bar from it.
 */
function canAny(can: (p: string) => boolean, permission: string | string[]): boolean {
  return Array.isArray(permission) ? permission.some(can) : can(permission);
}

export function App() {
  const { user, loading, can, signOut } = useAuth();
  const location = useLocation();
  const screens = useMyScreens();
  const [layout, setLayout] = useNavLayout();
  const [launcher, setLauncher] = useState(false);
  useLauncherShortcut(useCallback(() => setLauncher(true), []));

  // The guide is public: prospects and partners read it without an account.
  if (location.pathname === '/documentation') return <Navigate to="/docs" replace />;
  if (location.pathname === '/docs' || location.pathname.startsWith('/docs/')) {
    return (
      <Suspense
        fallback={
          <div className="grid h-full place-items-center">
            <Spinner />
          </div>
        }
      >
        <Routes>
          <Route path="/docs/:slug?" element={<Docs />} />
        </Routes>
      </Suspense>
    );
  }

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

  // Land people on the first screen they are actually allowed to see.
  const home = screens.find((x) => x.to !== '/docs')?.to ?? '/products';
  const side = layout === 'side';

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-ink-200/80 sticky top-0 z-30 border-b bg-white/85 backdrop-blur-sm">
        <div className={`mx-auto flex h-14 items-center gap-3 px-4 sm:gap-5 sm:px-5 ${side ? '' : 'max-w-[1500px]'}`}>
          <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Home">
            <div className="bg-accent-600 grid size-7 shrink-0 place-items-center rounded-md">
              <svg viewBox="0 0 24 24" className="size-4 text-white" aria-hidden="true">
                <path fill="currentColor" d="M4 7h16v2H4zm0 4h10v2H4zm0 4h16v2H4zm12-4h4v2h-4z" />
              </svg>
            </div>
            <div className="leading-none">
              <div className="text-[13px] font-semibold tracking-tight whitespace-nowrap">Retail Operations</div>
              <div className="text-ink-400 mt-0.5 hidden text-[10.5px] whitespace-nowrap 2xl:block">Multi-branch control</div>
            </div>
          </a>

          {!side && <TopBar screens={screens} max={9} />}

          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setLauncher(true)}
              className="border-ink-200 text-ink-400 hover:text-ink-700 hover:border-ink-300 hidden items-center gap-2 rounded-lg border bg-white px-2.5 py-1 text-[12.5px] md:flex"
              aria-label="Find a screen"
            >
              <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
                <path fill="currentColor" d="M8.5 3a5.5 5.5 0 0 1 4.4 8.8l3.7 3.7-1.1 1.1-3.7-3.7A5.5 5.5 0 1 1 8.5 3zm0 1.6a3.9 3.9 0 1 0 0 7.8 3.9 3.9 0 0 0 0-7.8z" />
              </svg>
              Search
              <kbd className="border-ink-200 rounded border px-1 text-[10.5px]">Ctrl K</kbd>
            </button>
            <LauncherButton onClick={() => setLauncher(true)} />
            <UserMenu />
          </div>
        </div>
      </header>

      <Launcher open={launcher} onClose={() => setLauncher(false)} screens={screens} layout={layout} onLayout={setLayout} onSignOut={() => void signOut()} />

      <div className="flex flex-1">
        {side && <SideBar screens={screens} />}
      <main className={`mx-auto w-full min-w-0 flex-1 px-4 py-5 sm:px-5 sm:py-6 ${side ? 'max-w-[1400px]' : 'max-w-[1500px]'}`}>
        <Routes>
          <Route path="/" element={can('dashboard.read') ? <Dashboard /> : <Navigate to={home} replace />} />
          <Route path="/sell" element={<Guard permission="movement.post" home={home}><Sell /></Guard>} />
          <Route path="/sales" element={<Guard permission="sale.read" home={home}><Sales /></Guard>} />
          <Route path="/profit" element={<Guard permission="sale.read" home={home}><Profit /></Guard>} />
          <Route path="/items" element={<Guard permission="sale.read" home={home}><Items /></Guard>} />
          <Route path="/suppliers/import" element={<Guard permission="supplier.write" home={home}><RecordImport kind="suppliers" /></Guard>} />
          <Route path="/suppliers" element={<Guard permission="supplier.read" home={home}><Suppliers /></Guard>} />
          <Route path="/suppliers/:id" element={<Guard permission="supplier.read" home={home}><SupplierDetail /></Guard>} />
          <Route path="/price-lists" element={<Guard permission="supplier.read" home={home}><PriceLists /></Guard>} />
          <Route path="/price-lists/new" element={<Guard permission="price.write" home={home}><NewPriceList /></Guard>} />
          <Route path="/price-lists/:id" element={<Guard permission="supplier.read" home={home}><PriceListDetailPage /></Guard>} />
          <Route path="/orders" element={<Guard permission="supplier.read" home={home}><Orders /></Guard>} />
          <Route path="/orders/new" element={<Guard permission="po.write" home={home}><NewOrder /></Guard>} />
          <Route path="/orders/:id" element={<Guard permission="supplier.read" home={home}><OrderDetail /></Guard>} />
          <Route path="/receive" element={<Guard permission="grn.post" home={home}><Receive /></Guard>} />
          <Route path="/receive/:id" element={<Guard permission="supplier.read" home={home}><ReceiveDetail /></Guard>} />
          <Route path="/returns" element={<Guard permission="supplier.read" home={home}><Returns /></Guard>} />
          <Route path="/returns/new" element={<Guard permission="purchase.return" home={home}><NewReturn /></Guard>} />
          <Route path="/returns/:id" element={<Guard permission="supplier.read" home={home}><ReturnDetailPage /></Guard>} />
          <Route path="/payments" element={<Guard permission="supplier.read" home={home}><Payments /></Guard>} />
          <Route path="/owed" element={<Guard permission="supplier.read" home={home}><Owed /></Guard>} />
          <Route path="/opening-stock" element={<Guard permission="stock.opening" home={home}><OpeningStock /></Guard>} />
          <Route path="/opening-stock/:id" element={<Guard permission="stock.read" home={home}><OpeningStockDetail /></Guard>} />
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
          <Route path="/shifts" element={<Guard permission={['shift.manage', 'sale.read']} home={home}><Shifts /></Guard>} />
          {/* A cashier reads their own closed shift; the API decides whose. */}
          <Route path="/shifts/:id" element={<Guard permission={['shift.open', 'shift.manage', 'sale.read']} home={home}><ShiftReportPage /></Guard>} />
          <Route path="/day-close" element={<Guard permission={['day.close', 'sale.read']} home={home}><DayClose /></Guard>} />
          <Route path="/day-close/:id" element={<Guard permission={['day.close', 'sale.read']} home={home}><ZReportPage /></Guard>} />
          <Route path="/customers/import" element={<Guard permission="customer.write" home={home}><RecordImport kind="customers" /></Guard>} />
          <Route path="/customers" element={<Guard permission="customer.read" home={home}><Customers /></Guard>} />
          <Route path="/customers/:id" element={<Guard permission="customer.read" home={home}><CustomerDetailPage /></Guard>} />
          <Route path="/debtors" element={<Guard permission="customer.read" home={home}><DebtorsPage /></Guard>} />
          <Route path="/audit" element={<Guard permission="audit.read" home={home}><Audit /></Guard>} />
          <Route path="/exceptions" element={<Guard permission="exception.read" home={home}><Exceptions /></Guard>} />
          <Route path="/stock" element={<Guard permission="stock.read" home={home}><Stock /></Guard>} />
          <Route path="/reports" element={<Guard permission="stock.read" home={home}><Reports /></Guard>} />
          <Route path="/products/import" element={<Guard permission="product.write" home={home}><ItemImport /></Guard>} />
          <Route path="/products" element={<Guard permission="product.read" home={home}><Products /></Guard>} />
          <Route path="/prices" element={<Guard permission="price.write" home={home}><Prices /></Guard>} />
          <Route path="/ledger" element={<Guard permission="stock.read" home={home}><Ledger /></Guard>} />
          <Route path="/users" element={<Guard permission="user.read" home={home}><Users /></Guard>} />
          <Route path="/exports" element={<Guard permission="data.export" home={home}><Exports /></Guard>} />
          <Route path="/reorder" element={<Guard permission="po.write" home={home}><Reorder /></Guard>} />
          <Route path="/users/:id/access" element={<Guard permission="user.read" home={home}><UserAccessPage /></Guard>} />
          <Route path="/branches" element={<Guard permission="branch.manage" home={home}><Branches /></Guard>} />
          <Route path="/settings" element={<Guard permission="settings.manage" home={home}><Settings /></Guard>} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
      </div>
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
      <div className="hidden text-right whitespace-nowrap 2xl:block">
        <div className="text-[12px] font-medium leading-tight">{user.fullName}</div>
        <div className="text-ink-400 text-[10.5px] leading-tight">
          {user.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}
        </div>
      </div>
      <div className="bg-ink-200 text-ink-700 grid size-7 shrink-0 place-items-center rounded-full text-[10.5px] font-semibold">
        {initials}
      </div>
      {/* On smaller screens, Sign out is at the foot of the all-screens panel. */}
      <button
        onClick={() => void signOut()}
        className="text-ink-400 hover:text-ink-800 hover:bg-ink-100 hidden rounded-lg px-2 py-1.5 text-[12px] font-medium whitespace-nowrap transition lg:inline-flex"
      >
        Sign out
      </button>
    </div>
  );
}
