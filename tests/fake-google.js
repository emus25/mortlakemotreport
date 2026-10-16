/* A small stand-in for the Google services Code.gs uses (Drive, Script
 * Properties, locks, Utilities, and the call out to Claude), so the real
 * Code.gs can be run and tested on any computer without touching anyone's
 * Google account. Only what Code.gs actually calls is implemented.
 *
 * Drive is held in memory as folders and files with ids, like the real thing:
 * moving, renaming and trashing behave the way Code.gs expects. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeDrive(isLocked) {
  let nextId = 1;
  const items = new Map();   // id -> folder | file
  // Every call that would be a round trip to Drive in real Apps Script, so
  // tests can keep the number per save down (each one costs real time).
  const calls = { n: 0, locked: 0 };
  const count = (fn) => function () { calls.n++; if (isLocked && isLocked()) calls.locked++; return fn.apply(this, arguments); };

  function iterator(list) {
    let i = 0;
    return { hasNext: () => i < list.length, next: () => list[i++] };
  }

  function makeFolder(name, parentId) {
    const id = 'folder' + nextId++;
    const f = {
      _type: 'folder', _id: id, _name: name, _parent: parentId, _trashed: false,
      getId: () => id,
      getName: () => f._name,
      getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      isTrashed: () => f._trashed,
      setTrashed: (t) => { f._trashed = !!t; },
      createFolder: count((n) => makeFolder(n, id)),
      getFoldersByName: count((n) => iterator(children(id).filter(c => c._type === 'folder' && c._name === n && !c._trashed))),
      getFilesByName: count((n) => iterator(children(id).filter(c => c._type === 'file' && c._name === n && !c._trashed))),
      getFiles: () => iterator(children(id).filter(c => c._type === 'file' && !c._trashed)),
      getFolders: () => iterator(children(id).filter(c => c._type === 'folder' && !c._trashed)),
      createFile: count((a, content, mime) => {
        if (typeof a === 'string') return makeFile(a, Buffer.from(String(content), 'utf8'), mime || 'text/plain', id);
        return makeFile(a._name || 'Untitled', Buffer.from(a._bytes), a._type, id);
      })
    };
    items.set(id, f);
    return f;
  }

  function makeFile(name, bytes, mime, parentId) {
    const id = 'file' + nextId++;
    const f = {
      _type: 'file', _id: id, _name: name, _bytes: bytes, _mime: mime, _parent: parentId, _trashed: false,
      getId: () => id,
      getName: () => f._name,
      setName: (n) => { f._name = n; return f; },
      getSize: () => f._bytes.length,
      getMimeType: () => f._mime,
      isTrashed: () => f._trashed,
      setTrashed: (t) => { f._trashed = !!t; },
      getUrl: () => 'https://drive.google.com/file/d/' + id,
      setContent: count((s) => { f._bytes = Buffer.from(String(s), 'utf8'); return f; }),
      moveTo: count((folder) => { f._parent = folder.getId(); return f; }),
      getBlob: count(() => makeBlob(f._bytes, f._mime, f._name))
    };
    items.set(id, f);
    return f;
  }

  function children(parentId) {
    return [...items.values()].filter(x => x._parent === parentId);
  }

  const root = makeFolder('My Drive', null);

  const DriveApp = {
    getRootFolder: () => root,
    createFolder: (n) => root.createFolder(n),
    getFolderById: count((id) => { const f = items.get(id); if (!f || f._type !== 'folder') throw new Error('No folder ' + id); return f; }),
    getFileById: count((id) => { const f = items.get(id); if (!f || f._type !== 'file') throw new Error('No file ' + id); return f; })
  };

  // Test helpers: look at Drive as a tree of names.
  function pathOf(item) {
    const parts = [];
    let cur = item;
    while (cur && cur._parent) { parts.unshift(cur._name); cur = items.get(cur._parent); }
    return parts.join('/');
  }
  function list() {
    return [...items.values()].filter(x => x._type === 'file' && !x._trashed).map(pathOf).sort();
  }
  function readText(p) {
    const f = [...items.values()].find(x => x._type === 'file' && !x._trashed && pathOf(x) === p);
    return f ? f._bytes.toString('utf8') : null;
  }
  function readBytes(p) {
    const f = [...items.values()].find(x => x._type === 'file' && !x._trashed && pathOf(x) === p);
    return f ? f._bytes : null;
  }
  function deleteByPath(p) {
    const f = [...items.values()].find(x => !x._trashed && pathOf(x) === p);
    if (f) items.delete(f._id);
  }
  return { DriveApp, list, readText, readBytes, deleteByPath, items, calls };
}

function makeBlob(bytes, type, name) {
  const buf = Buffer.from(bytes);
  return {
    _bytes: buf, _type: type, _name: name,
    getBytes: () => Array.from(buf).map(b => (b > 127 ? b - 256 : b)),   // Java bytes are signed
    getDataAsString: () => buf.toString('utf8'),
    getContentType: () => type,
    getName: () => name,
    setName: function (n) { this._name = n; return this; }
  };
}

function toBuffer(bytes) {
  return Buffer.from(Array.from(bytes).map(b => (b < 0 ? b + 256 : b)));
}

/* Loads Code.gs into a fresh sandbox with fake services.
   options.claude(kind, payload) -> { status, result } lets a test decide
   what Claude "reads"; throwing or returning an HTTP code simulates errors. */
function loadBackend(options) {
  options = options || {};
  let locked = false;
  const drive = makeDrive(() => locked);
  const props = new Map(Object.entries(Object.assign({
    DASHBOARD_PASSWORD: 'pw', ANTHROPIC_API_KEY: 'sk-test'
  }, options.properties || {})));

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
      deleteProperty: (k) => { props.delete(k); },
      getProperties: () => Object.fromEntries(props)
    })
  };

  // One real lock: requests in these tests run one after another, so the
  // lock is checked for being taken twice (a bug), not for waiting.
  const LockService = {
    getScriptLock: () => ({
      waitLock: () => { if (locked) throw new Error('Lock already held — nested withLock_'); locked = true; },
      tryLock: () => { if (locked) return false; locked = true; return true; },
      releaseLock: () => { locked = false; }
    })
  };

  const Utilities = {
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)),
    base64Encode: (bytes) => toBuffer(bytes).toString('base64'),
    newBlob: (data, type, name) => makeBlob(typeof data === 'string' ? Buffer.from(data) : toBuffer(data), type, name),
    sleep: () => {},
    getUuid: () => require('crypto').randomUUID(),
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, value) => Array.from(require('crypto').createHash(alg).update(String(value), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b))
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (s) => ({ _s: s, setMimeType: function () { return this; }, getContent: function () { return this._s; } })
  };

  const calls = { claude: 0 };
  const UrlFetchApp = {
    fetch: (url, opts) => {
      calls.claude++;
      const payload = JSON.parse(opts.payload);
      const text = payload.messages[0].content[1].text;
      const kind = /CALIBRATION CERTIFICATE/.test(text) ? 'cert' : 'qc';
      const image = payload.messages[0].content[0].source.data;
      const out = options.claude ? options.claude(kind, image) : { status: 'success', result: { category: 'other' } };
      if (out.http) {
        return { getResponseCode: () => out.http, getContentText: () => JSON.stringify({ error: { message: 'HTTP ' + out.http } }), getAllHeaders: () => ({}) };
      }
      const body = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out.result) }] };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body), getAllHeaders: () => ({}) };
    }
  };

  const sandbox = { DriveApp: drive.DriveApp, PropertiesService, LockService, Utilities, ContentService, UrlFetchApp,
                    console, JSON, Date, Math };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'Code.gs' });

  function call(action, payload) {
    const body = Object.assign({ action, password: 'pw' }, payload || {});
    const out = sandbox.doPost({ postData: { contents: JSON.stringify(body) } });
    if (locked) throw new Error('Lock left held after ' + action);
    return JSON.parse(out.getContent());
  }

  return { call, drive, props, calls, sandbox,
           doPostRaw: (text) => JSON.parse(sandbox.doPost({ postData: { contents: text } }).getContent()) };
}

module.exports = { loadBackend };
