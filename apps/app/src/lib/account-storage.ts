let identity: string | null = null;
let storageIdentity: string | null = null;
let sessionEpoch: string | null = null;
let configured = false;
let used = false;
const reservedPrefix = "bb.account.";
export const browserIdentityMarker = "bb.control-plane.identity.v1";
const adapters = new WeakMap<Storage, Storage>();
export function configureAccountStorage(
  value: string | null,
  epoch: string | null = null,
): void {
  const storage =
    value === null || epoch === null ? value : `${value}@${epoch}`;
  if (
    (configured || used) &&
    (identity !== value || storageIdentity !== storage)
  )
    throw new Error("Browser identity requires a fresh application context");
  identity = value;
  sessionEpoch = epoch;
  storageIdentity = storage;
  configured = true;
}
export function activeBrowserIdentity(): string | null {
  return identity;
}
export function activeBrowserSessionEpoch(): string | null {
  return sessionEpoch;
}
export function accountStoragePrefix(value: string): string {
  return `${reservedPrefix}${encodeURIComponent(value)}.`;
}
export function accountDatabaseName(name: string): string {
  used = true;
  return storageIdentity === null
    ? name
    : `${name}.${encodeURIComponent(storageIdentity)}`;
}
function adapt(raw: Storage): Storage {
  used = true;
  if (storageIdentity === null) return raw;
  const old = adapters.get(raw);
  if (old) return old;
  const prefix = accountStoragePrefix(storageIdentity);
  const ownedKeys = () =>
    Array.from({ length: raw.length }, (_, index) => raw.key(index)).filter(
      (key): key is string => key !== null && key.startsWith(prefix),
    );
  const value: Storage = {
    get length() {
      return ownedKeys().length;
    },
    key: (index) => ownedKeys()[index]?.slice(prefix.length) ?? null,
    getItem: (key) => raw.getItem(prefix + key),
    setItem: (key, value) => raw.setItem(prefix + key, value),
    removeItem: (key) => raw.removeItem(prefix + key),
    clear() {
      for (const key of ownedKeys()) raw.removeItem(key);
    },
  };
  adapters.set(raw, value);
  return value;
}
export function accountLocalStorage(): Storage {
  return adapt(window.localStorage);
}
export function accountSessionStorage(): Storage {
  return adapt(window.sessionStorage);
}
export function accountStorageEventKey(
  event: Pick<StorageEvent, "key" | "storageArea">,
): string | null {
  if (event.storageArea !== window.localStorage || event.key === null)
    return null;
  if (storageIdentity === null)
    return event.key.startsWith(reservedPrefix) ? null : event.key;
  const prefix = accountStoragePrefix(storageIdentity);
  return event.key.startsWith(prefix) ? event.key.slice(prefix.length) : null;
}
export function clearAccountStorage(raw: Storage, value: string | null): void {
  const prefix = value === null ? null : accountStoragePrefix(value);
  const keys = Array.from({ length: raw.length }, (_, index) => raw.key(index));
  for (const key of keys) {
    if (key === null || key === browserIdentityMarker) continue;
    if (
      prefix === null ? !key.startsWith(reservedPrefix) : key.startsWith(prefix)
    )
      raw.removeItem(key);
  }
}

export function clearInactiveAccountStorage(
  raw: Storage,
  active: string | null,
): void {
  const prefix = active === null ? null : accountStoragePrefix(active);
  const keys = Array.from({ length: raw.length }, (_, index) => raw.key(index));
  for (const key of keys) {
    if (
      key !== null &&
      key.startsWith(reservedPrefix) &&
      (prefix === null || !key.startsWith(prefix))
    )
      raw.removeItem(key);
  }
}
