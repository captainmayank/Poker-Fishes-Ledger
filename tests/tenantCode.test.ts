import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// -----------------------------------------------------------
// Minimal localStorage stub. We run vitest with
// `environment: 'node'` so there is no window/localStorage --
// the helpers are written to fall back gracefully but here we
// want to exercise the happy path, so stand up a stub.
// -----------------------------------------------------------
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

let restoreWindow: (() => void) | null = null;

function installWindow() {
  const g = globalThis as unknown as { window?: { localStorage: MemoryStorage } };
  const prev = g.window;
  g.window = { localStorage: new MemoryStorage() };
  restoreWindow = () => {
    if (prev) g.window = prev;
    else delete (globalThis as { window?: unknown }).window;
  };
}

function uninstallWindow() {
  restoreWindow?.();
  restoreWindow = null;
}

import {
  getTenantCode,
  setTenantCode,
  clearTenantCode,
  normalizeTenantCode,
  seedDefaultTenantIfNeeded,
  TENANT_CODE_KEY,
  TENANT_SEEDED_KEY,
  DEFAULT_SEED_TENANT_CODE,
} from '../src/lib/tenantCode';

describe('tenantCode helpers', () => {
  beforeEach(() => {
    installWindow();
  });

  afterEach(() => {
    uninstallWindow();
    vi.restoreAllMocks();
  });

  it('returns null when nothing is stored', () => {
    expect(getTenantCode()).toBeNull();
  });

  it('setTenantCode then getTenantCode round-trips the code', () => {
    setTenantCode('abc123');
    expect(getTenantCode()).toBe('ABC123');
  });

  it('setTenantCode normalises to uppercase + trims whitespace', () => {
    setTenantCode('  zxy987  ');
    expect(getTenantCode()).toBe('ZXY987');
  });

  it('setTenantCode with empty string clears storage', () => {
    setTenantCode('ABC123');
    setTenantCode('');
    expect(getTenantCode()).toBeNull();
  });

  it('setTenantCode with null clears storage', () => {
    setTenantCode('ABC123');
    setTenantCode(null);
    expect(getTenantCode()).toBeNull();
  });

  it('clearTenantCode removes the stored code', () => {
    setTenantCode('ABC123');
    clearTenantCode();
    expect(getTenantCode()).toBeNull();
  });

  it('clearTenantCode is a no-op when nothing stored', () => {
    expect(() => clearTenantCode()).not.toThrow();
    expect(getTenantCode()).toBeNull();
  });

  it('uses the TENANT_CODE_KEY for underlying storage', () => {
    setTenantCode('HELLO1');
    const raw = (globalThis as unknown as { window?: { localStorage: MemoryStorage } }).window!
      .localStorage.getItem(TENANT_CODE_KEY);
    expect(raw).toBe('HELLO1');
  });

  it('getTenantCode normalises dirty persisted values', () => {
    // Simulate a previous version writing lower-case.
    (globalThis as unknown as { window?: { localStorage: MemoryStorage } }).window!.localStorage.setItem(
      TENANT_CODE_KEY,
      '  lower9 '
    );
    expect(getTenantCode()).toBe('LOWER9');
  });

  it('getTenantCode returns null when a blank string was stored', () => {
    (globalThis as unknown as { window?: { localStorage: MemoryStorage } }).window!.localStorage.setItem(
      TENANT_CODE_KEY,
      '   '
    );
    expect(getTenantCode()).toBeNull();
  });

  it('normalizeTenantCode handles null/undefined/empty', () => {
    expect(normalizeTenantCode(null)).toBe('');
    expect(normalizeTenantCode(undefined)).toBe('');
    expect(normalizeTenantCode('')).toBe('');
    expect(normalizeTenantCode('  ')).toBe('');
  });

  it('helpers are no-ops when window is undefined', () => {
    uninstallWindow();
    expect(getTenantCode()).toBeNull();
    expect(() => setTenantCode('X1Y2Z3')).not.toThrow();
    expect(() => clearTenantCode()).not.toThrow();
  });
});

describe('seedDefaultTenantIfNeeded', () => {
  function getStorage() {
    return (globalThis as unknown as { window?: { localStorage: MemoryStorage } }).window!
      .localStorage;
  }

  beforeEach(() => {
    installWindow();
  });

  afterEach(() => {
    uninstallWindow();
    vi.restoreAllMocks();
  });

  it('seeds OGFISH and sets tenantSeeded on a first visit (no code, no flag)', () => {
    const seeded = seedDefaultTenantIfNeeded();

    expect(seeded).toBe(DEFAULT_SEED_TENANT_CODE);
    expect(getTenantCode()).toBe('OGFISH');
    expect(getStorage().getItem(TENANT_SEEDED_KEY)).toBe('1');
  });

  it('is a no-op on a returning visit (code=OGFISH, flag=1)', () => {
    const storage = getStorage();
    storage.setItem(TENANT_CODE_KEY, 'OGFISH');
    storage.setItem(TENANT_SEEDED_KEY, '1');

    const seeded = seedDefaultTenantIfNeeded();

    expect(seeded).toBeNull();
    expect(getTenantCode()).toBe('OGFISH');
    expect(storage.getItem(TENANT_SEEDED_KEY)).toBe('1');
  });

  it('is a no-op after the user cleared their code via Switch Group (flag=1, no code)', () => {
    // Simulate: user was seeded before, then hit "Switch Group" which
    // cleared the tenant code but left the sentinel behind.
    const storage = getStorage();
    storage.setItem(TENANT_SEEDED_KEY, '1');

    const seeded = seedDefaultTenantIfNeeded();

    expect(seeded).toBeNull();
    expect(getTenantCode()).toBeNull();
    // Flag must still be there so the next load is also a no-op.
    expect(storage.getItem(TENANT_SEEDED_KEY)).toBe('1');
  });

  it('is a no-op when the user is already on a different tenant (code=ACES42, flag=1)', () => {
    const storage = getStorage();
    storage.setItem(TENANT_CODE_KEY, 'ACES42');
    storage.setItem(TENANT_SEEDED_KEY, '1');

    const seeded = seedDefaultTenantIfNeeded();

    expect(seeded).toBeNull();
    expect(getTenantCode()).toBe('ACES42');
  });

  it('marks an already-chosen tenant as seeded without overwriting it', () => {
    // Edge case: landing page ran in a previous session and picked
    // ACES42 before the seeder shipped. On next load we must not
    // overwrite their choice, but we should still set the sentinel
    // so we stay a no-op from here on.
    const storage = getStorage();
    storage.setItem(TENANT_CODE_KEY, 'ACES42');

    const seeded = seedDefaultTenantIfNeeded();

    expect(seeded).toBeNull();
    expect(getTenantCode()).toBe('ACES42');
    expect(storage.getItem(TENANT_SEEDED_KEY)).toBe('1');
  });

  it('is a no-op when window is undefined (SSR-safe)', () => {
    uninstallWindow();
    expect(() => seedDefaultTenantIfNeeded()).not.toThrow();
    expect(seedDefaultTenantIfNeeded()).toBeNull();
  });
});
