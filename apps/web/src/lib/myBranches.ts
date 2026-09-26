/**
 * The branches the signed-in person may act at.
 *
 * Someone tied to branches (a cashier, a branch manager) acts only at those;
 * offering them the others would only lead to a refusal from the server. A
 * group-wide person gets every branch.
 */

import { api, type Branch } from './api.js';
import { useAuth } from './auth.js';
import { useAsync } from './ui.js';

export function useMyBranches(): { list: Branch[]; loading: boolean } {
  const { user } = useAuth();
  const all = useAsync(() => api.branches(), []);
  const scoped = user?.branchIds ?? [];
  return { list: (all.data ?? []).filter((b) => scoped.length === 0 || scoped.includes(b.id)), loading: all.loading };
}
