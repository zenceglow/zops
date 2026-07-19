/**
 * Encrypted localStorage for sensitive persist payloads (AES-GCM via Web Crypto).
 * Device key lives in IndexedDB (not next to the ciphertext in localStorage).
 */

const IDB_NAME = 'zenceglow-ops-secure';
const IDB_STORE = 'keys';
const IDB_KEY = 'device-aes-gcm';
const ENC_PREFIX = 'zgenc1:';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function idbGet(): Promise<CryptoKey | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'));
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(key: CryptoKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(key, IDB_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
  });
}

let keyPromise: Promise<CryptoKey> | null = null;

async function getDeviceKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await idbGet();
      if (existing) return existing;
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      await idbPut(key);
      return key;
    })();
  }
  return keyPromise;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptString(plain: string): Promise<string> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `${ENC_PREFIX}${bytesToB64(iv)}.${bytesToB64(new Uint8Array(cipher))}`;
}

export async function decryptString(payload: string): Promise<string> {
  if (!payload.startsWith(ENC_PREFIX)) {
    throw new Error('Not an encrypted payload');
  }
  const rest = payload.slice(ENC_PREFIX.length);
  const [ivB64, dataB64] = rest.split('.');
  if (!ivB64 || !dataB64) throw new Error('Malformed encrypted payload');
  const key = await getDeviceKey();
  const iv = b64ToBytes(ivB64);
  const data = b64ToBytes(dataB64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    data as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

/** Zustand persist storage: values written to localStorage are AES-GCM ciphertext. */
export const encryptedLocalStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const raw = localStorage.getItem(name);
    if (raw == null) return null;
    try {
      if (raw.startsWith(ENC_PREFIX)) {
        return await decryptString(raw);
      }
      // Migrate legacy plaintext zustand JSON → encrypted
      if (raw.startsWith('{')) {
        await encryptedLocalStorage.setItem(name, raw);
        return raw;
      }
      localStorage.removeItem(name);
      return null;
    } catch {
      localStorage.removeItem(name);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    const enc = await encryptString(value);
    localStorage.setItem(name, enc);
  },
  removeItem: async (name: string): Promise<void> => {
    localStorage.removeItem(name);
  },
};
