/* Derived CFI indexes only: no chapter text, progress, annotations or credentials. */
(() => {
  const DATABASE = 'endpaper-reader-indexes', STORE = 'locations';
  const MAX_ITEM_BYTES = 2_000_000, MAX_BYTES = 8_000_000, MAX_ITEMS = 12;
  let connectionPromise;
  function open() {
    if (!window.indexedDB) return Promise.reject(new Error('Index storage unavailable'));
    if (!connectionPromise) {
      connectionPromise = new Promise((resolve, reject) => {
        let settled = false;
        const fail = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
        const timer = setTimeout(() => fail(new Error('Index storage timed out')), 1000);
        let request;
        try { request = indexedDB.open(DATABASE, 1); }
        catch (error) { fail(error); return; }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error('Index storage blocked'));
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true; clearTimeout(timer);
          const db = request.result;
          db.onversionchange = () => { db.close(); connectionPromise = null; };
          resolve(db);
        };
      }).catch(error => { connectionPromise = null; throw error; });
    }
    return connectionPromise;
  }
  async function transaction(mode, work) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let result = null;
        const timer = setTimeout(() => { try { tx.abort(); } catch (_) {} reject(new Error('Index storage timed out')); }, 1000);
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error || new Error('Index storage failed')); };
        try { work(tx.objectStore(STORE), value => { result = value; }); }
        catch (error) { clearTimeout(timer); try { tx.abort(); } catch (_) {} reject(error); }
      });
    } catch (_) { return null; } // A cache failure must never block reading.
  }
  const keyOf = (account, bookId, fingerprint) => JSON.stringify(['locations-1024-v1', account.toLocaleLowerCase(), bookId, fingerprint]);
  window.readerIndexStore = {
    async get(account, bookId, fingerprint) {
      return transaction('readwrite', (store, done) => {
        const request = store.get(keyOf(account, bookId, fingerprint));
        request.onsuccess = () => {
          const record = request.result;
          if (typeof record?.locations !== 'string' || record.locations.length > MAX_ITEM_BYTES) return;
          record.accessedAt = Date.now(); store.put(record); done(record.locations);
        };
      });
    },
    async put(account, bookId, fingerprint, locations) {
      if (typeof locations !== 'string' || locations.length > MAX_ITEM_BYTES) return;
      return transaction('readwrite', (store, done) => {
        const record = { key: keyOf(account, bookId, fingerprint), bookId, locations, accessedAt: Date.now() };
        const request = store.getAll();
        request.onsuccess = () => {
          const records = request.result.filter(item => item.key !== record.key).sort((a, b) => a.accessedAt - b.accessedAt);
          let bytes = locations.length + records.reduce((sum, item) => sum + (item.locations?.length || 0), 0);
          while (records.length + 1 > MAX_ITEMS || bytes > MAX_BYTES) {
            const oldest = records.shift(); bytes -= oldest.locations?.length || 0; store.delete(oldest.key);
          }
          store.put(record); done(true);
        };
      });
    },
    async deleteBook(bookId) {
      return transaction('readwrite', store => {
        const request = store.getAll();
        request.onsuccess = () => request.result.filter(item => item.bookId === bookId).forEach(item => store.delete(item.key));
      });
    },
  };
})();
