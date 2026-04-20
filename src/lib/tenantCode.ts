// Single source of truth for the browser-side group/tenant code.
//
// The tenancy model (Phase 3) requires every API request to carry a
// short human-readable group code. The code is persisted in
// localStorage so a returning user lands directly in their group.
// The landing page (`GroupLanding`), the App shell, and the fetch
// helpers all go through this module so the storage key is never
// hard-coded in more than one place.
//
// The helpers are defensive: any environment without a functioning
// localStorage (SSR, private-mode Safari edge cases, tests without
// jsdom) degrades to a no-op rather than throwing.

export const TENANT_CODE_KEY = 'tenantCode';

// Flag key used to record that the one-time default-tenant seed has run
// for this browser. The flag is intentionally separate from the code
// itself so that if a user later explicitly clears their group (via
// "Switch group" in the shell), we do NOT re-seed them on the next load.
export const TENANT_SEEDED_KEY = 'tenantSeeded';

// Default group code assigned to existing users the first time they
// load the app after the multi-tenancy rollout. Chosen so the ~15
// pre-rollout users keep seeing their current data without having to
// type anything on the new landing page.
export const DEFAULT_SEED_TENANT_CODE = 'OGFISH';

function hasStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * Normalise a user-entered group code: trim + uppercase. Returns the
 * normalised code or an empty string for nullish input. We do not
 * reject short/long codes here; the server is authoritative on
 * length and character set.
 */
export function normalizeTenantCode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().toUpperCase();
}

/**
 * Read the current tenant code from localStorage. Returns null when
 * nothing is stored or storage is unavailable.
 */
export function getTenantCode(): string | null {
  if (!hasStorage()) return null;
  try {
    const v = window.localStorage.getItem(TENANT_CODE_KEY);
    if (!v) return null;
    const norm = normalizeTenantCode(v);
    return norm || null;
  } catch {
    return null;
  }
}

/**
 * Persist a tenant code. Input is normalised before writing so
 * callers don't have to remember to uppercase. An empty/nullish code
 * is treated as a clear.
 */
export function setTenantCode(code: string | null | undefined): void {
  if (!hasStorage()) return;
  const norm = normalizeTenantCode(code ?? '');
  try {
    if (!norm) {
      window.localStorage.removeItem(TENANT_CODE_KEY);
      return;
    }
    window.localStorage.setItem(TENANT_CODE_KEY, norm);
  } catch {
    // swallow: storage quota / disabled storage should not crash UI.
  }
}

/**
 * Remove the stored tenant code. Safe to call when nothing is set.
 */
export function clearTenantCode(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(TENANT_CODE_KEY);
  } catch {
    // swallow.
  }
}

/**
 * One-time seed of the default tenant code for existing users.
 *
 * Rolling out multi-tenancy means the ~15 pre-existing users would
 * otherwise be greeted by the new `GroupLanding` page and asked to
 * pick a group they shouldn't have to think about. To keep them on
 * their existing data without friction, we seed `OGFISH` the very
 * first time the app runs in a browser that has neither a stored
 * code nor the `tenantSeeded` sentinel.
 *
 * The sentinel is what makes this a ONE-TIME operation: once a
 * browser has been seeded (or the user has explicitly chosen
 * "Switch group" and cleared their code after the flag was set),
 * we respect their intent and never re-seed. New users who land on
 * `GroupLanding` first will also get `tenantSeeded` written on
 * subsequent calls, so this helper never fights the landing flow.
 *
 * Returns the seeded code when a seed was written this call, or
 * null when the helper was a no-op.
 */
export function seedDefaultTenantIfNeeded(): string | null {
  if (!hasStorage()) return null;
  try {
    const alreadySeeded = window.localStorage.getItem(TENANT_SEEDED_KEY);
    if (alreadySeeded) return null;
    const existing = window.localStorage.getItem(TENANT_CODE_KEY);
    if (existing && normalizeTenantCode(existing)) {
      // User already has a code (e.g. was set by landing page in a
      // previous session before this seeder shipped). Mark as seeded
      // so we don't interfere in the future, but leave their code
      // untouched.
      window.localStorage.setItem(TENANT_SEEDED_KEY, '1');
      return null;
    }
    setTenantCode(DEFAULT_SEED_TENANT_CODE);
    window.localStorage.setItem(TENANT_SEEDED_KEY, '1');
    return DEFAULT_SEED_TENANT_CODE;
  } catch {
    return null;
  }
}
