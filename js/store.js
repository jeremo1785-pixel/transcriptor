// Biblioteca guardada en el propio iPad (IndexedDB). Nada se sube a ningun lado.
// Dos almacenes: "songs" (datos livianos para la lista) y "blobs" (el audio y
// la transcripcion, que pesan mas y solo se leen al abrir una cancion).

const DB = "transcriptor", VER = 1;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((ok, bad) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("songs")) d.createObjectStore("songs", { keyPath: "id" });
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
    // Pide que el navegador no borre los datos por falta de espacio.
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((ok, bad) => {
    const t = d.transaction(store, mode);
    const res = fn(t.objectStore(store));
    t.oncomplete = () => ok(res && "result" in res ? res.result : res);
    t.onerror = () => bad(t.error);
    t.onabort = () => bad(t.error || new Error("Operación cancelada"));
  }));
}

export const store = {
  list: () => tx("songs", "readonly", s => s.getAll())
    .then(a => a.sort((x, y) => (y.created || 0) - (x.created || 0))),
  get: id => tx("songs", "readonly", s => s.get(id)),
  put: song => tx("songs", "readwrite", s => s.put(song)),
  async update(id, fields) {
    const s = await this.get(id);
    if (!s) return null;
    Object.assign(s, fields);
    await this.put(s);
    return s;
  },
  getBlob: key => tx("blobs", "readonly", s => s.get(key)),
  putBlob: (key, val) => tx("blobs", "readwrite", s => s.put(val, key)),
  async remove(id) {
    await tx("songs", "readwrite", s => s.delete(id));
    await tx("blobs", "readwrite", s => { s.delete(id + ":audio"); s.delete(id + ":notes"); });
  },
};
