const DB_NAME = 'dro-canvass';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('households')) {
        db.createObjectStore('households', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('voters')) {
        const voterStore = db.createObjectStore('voters', { keyPath: 'id' });
        voterStore.createIndex('householdId', 'householdId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putAll(db, storeName, records) {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const record of records) store.put(record);
  await txDone(tx);
}

export function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getByIndex(db, storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly')
      .objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(db, storeName, record) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(record);
  await txDone(tx);
}

// Read-modify-write inside ONE readwrite transaction. Doing the read and the
// write as separate transactions loses edits: two controls changed in quick
// succession each read the record before the other's write commits, so the
// second write clobbers the first. IndexedDB serializes readwrite
// transactions over the same store, which makes this safe.
export function update(db, storeName, key, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    let updated = null;
    req.onsuccess = () => {
      const record = req.result;
      if (!record) return;
      Object.assign(record, patch);
      store.put(record);
      updated = record;
    };
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getMeta(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(db, key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}
