// A minimal WASI (preview1) host for the LLVM driver of js/appbuild/toolchain.mjs: what clang (cc1, cc1as, the
// driver with -###) and ld.lld call, on a file system in memory, nothing else. The same code runs in a Web Worker and
// under node (no imports, no DOM): everything is synchronous, so in the page it belongs in a worker.
//
// createFs() is the file tree: absolute POSIX paths, files as bytes, directories implied by the files below them
// (and by mkdir()). Packs are mounted read-only (js/appbuild/packs.mjs: their bytes are views into the pack, not
// copies); what a program writes lies over them. runWasi() starts one instance of a compiled module with its
// arguments on that tree and gives back the exit code and what it printed: a trap of the WebAssembly code (an
// assertion of LLVM ends in abort()), a proc_exit() and a call this host does not have all come back as rc and text,
// never as an exception. An instance keeps nothing: every run has its own memory and its own descriptors, only the
// tree stays (/tmp too: the driver's temporary files go from one job to the next).

const E = { OK: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, SPIPE: 70 };
const FT = { CHAR: 2, DIR: 3, FILE: 4 };
const O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const MTIME = 1700000000000000000n; // one time for every file: nothing here is rebuilt by date

// "a/./b/../c" and a relative path against cwd, to "/a/c"
export function normalize(path, cwd = "/") {
  const out = [];
  for (const s of ((path.startsWith("/") ? "" : cwd + "/") + path).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop(); else out.push(s);
  }
  return "/" + out.join("/");
}

export function createFs() {
  const files = new Map(); // path -> { data: Uint8Array, len, ro }: len bytes of data are the file (data grows by doubling)
  const dirs = new Set(["/", "/tmp"]);
  const inodes = new Map(); // clang tells files apart by device and inode: one number per path, for good
  const mkdirs = (path) => {
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const d = path.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
    }
  };
  const enc = new TextEncoder();
  const fs = {
    // the bytes of a file (a copy for a written one, the pack's own bytes for a mounted one: not to be changed), or null
    readFile(path) {
      const f = files.get(normalize(path));
      return f ? (f.ro ? f.data.subarray(0, f.len) : f.data.slice(0, f.len)) : null;
    },
    readText(path) {
      const f = files.get(normalize(path));
      return f ? new TextDecoder().decode(f.data.subarray(0, f.len)) : null;
    },
    writeFile(path, data) {
      path = normalize(path);
      if (typeof data === "string") data = enc.encode(data); else data = data.slice();
      mkdirs(path);
      files.set(path, { data, len: data.length, ro: false });
    },
    exists(path) { path = normalize(path); return files.has(path) || dirs.has(path); },
    isDir(path) { return dirs.has(normalize(path)); },
    unlink(path) { return files.delete(normalize(path)); },
    mkdir(path) { path = normalize(path); mkdirs(path + "/x"); },
    // the files below a directory (or all): [path, ...], sorted
    list(prefix = "/") {
      prefix = normalize(prefix);
      const p = prefix === "/" ? "/" : prefix + "/";
      return [...files.keys()].filter((k) => k.startsWith(p)).sort();
    },
    // a pack's file, read-only, its bytes not copied (packs.mjs mountPack())
    mount(path, data) { mkdirs(path); files.set(path, { data, len: data.length, ro: true }); },
    // for runWasi()
    _files: files, _dirs: dirs, _mkdirs: mkdirs,
    _ino(path) { let n = inodes.get(path); if (!n) inodes.set(path, n = inodes.size + 100); return BigInt(n); },
  };
  return fs;
}

class Exit extends Error {
  constructor(code) { super("exit " + code); this.code = code; }
}

// Runs module (a WebAssembly.Module of a WASI command: _start, memory) with argv on fs. stdoutFile: the path of a
// file that takes what the program writes to its standard output (as bytes) instead of the returned text. Returns
// { rc, stdout, stderr, ms, memory }: rc -1 with the reason at the end of stderr for a trap.
export function runWasi(module, argv, fs, { stdoutFile = null, env = [] } = {}) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const args = argv.map((a) => enc.encode(a + "\0")), envs = env.map((a) => enc.encode(a + "\0"));
  const files = fs._files, dirs = fs._dirs;
  let memory, buffer = null, u8 = null, dv = null;
  const sync = () => { // the views die when the memory grows
    if (memory.buffer !== buffer) { buffer = memory.buffer; u8 = new Uint8Array(buffer); dv = new DataView(buffer); }
  };
  const chunks = { 1: [], 2: [] }; // what goes to stdout and stderr, as bytes: a character may be split over two writes
  const text = (c) => { let n = 0; for (const b of c) n += b.length; const a = new Uint8Array(n); n = 0; for (const b of c) { a.set(b, n); n += b.length; } return dec.decode(a); };
  const missing = new Set(); // calls this host does not have (answered with ENOSYS)

  const put = (f, pos, src) => {
    if (pos + src.length > f.data.length) {
      const n = new Uint8Array(Math.max(f.data.length * 2, pos + src.length, 4096));
      n.set(f.data.subarray(0, f.len)); f.data = n;
    }
    if (pos > f.len) f.data.fill(0, f.len, pos);
    f.data.set(src, pos); f.len = Math.max(f.len, pos + src.length);
  };
  const create = (path) => { const f = { data: new Uint8Array(0), len: 0, ro: false }; fs._mkdirs(path); files.set(path, f); return f; };
  let out = null;
  if (stdoutFile) out = create(normalize(stdoutFile));

  // descriptors: 0 nothing to read, 1 and 2 the texts, 3 the one preopened directory "/"
  const fds = new Map([[0, { type: "null" }], [1, { type: "out", n: 1 }], [2, { type: "out", n: 2 }], [3, { type: "dir", path: "/" }]]);
  let nextFd = 4;
  const str = (p, n) => dec.decode(u8.subarray(p, p + n));
  const resolve = (fd, ptr, len) => { const d = fds.get(fd); return d && d.type === "dir" ? normalize(str(ptr, len), d.path) : null; };
  const filestat = (ptr, path, type, size) => {
    u8.fill(0, ptr, ptr + 64);
    dv.setBigUint64(ptr, 1n, true); dv.setBigUint64(ptr + 8, fs._ino(path), true); dv.setUint8(ptr + 16, type);
    dv.setBigUint64(ptr + 24, 1n, true); dv.setBigUint64(ptr + 32, BigInt(size), true);
    for (const o of [40, 48, 56]) dv.setBigUint64(ptr + o, MTIME, true);
  };
  const read = (fd, iovs, n, pn, at) => {
    sync();
    const d = fds.get(fd); if (!d) return E.BADF;
    if (d.type === "dir") return E.ISDIR;
    let total = 0;
    if (d.type === "file") {
      const f = d.file; let pos = at ?? d.pos;
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(iovs + 8 * i, true), l = dv.getUint32(iovs + 8 * i + 4, true), k = Math.max(0, Math.min(l, f.len - pos));
        u8.set(f.data.subarray(pos, pos + k), p); pos += k; total += k;
        if (k < l) break;
      }
      if (at == null) d.pos = pos;
    }
    dv.setUint32(pn, total, true); return 0;
  };
  const write = (fd, iovs, n, pn, at) => {
    sync();
    const d = fds.get(fd); if (!d) return E.BADF;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = dv.getUint32(iovs + 8 * i, true), l = dv.getUint32(iovs + 8 * i + 4, true), src = u8.subarray(p, p + l);
      if (d.type === "out") { if (d.n === 1 && out) put(out, out.len, src); else chunks[d.n].push(src.slice()); }
      else if (d.type === "file") {
        if (d.file.ro) return E.ACCES;
        const pos = at != null ? at + total : d.append ? d.file.len : d.pos;
        put(d.file, pos, src);
        if (at == null) d.pos = pos + l;
      }
      else return E.BADF;
      total += l;
    }
    dv.setUint32(pn, total, true); return 0;
  };

  const wasi = {
    args_sizes_get(pc, ps) { sync(); dv.setUint32(pc, args.length, true); dv.setUint32(ps, args.reduce((a, b) => a + b.length, 0), true); return 0; },
    args_get(pv, pb) { sync(); for (const a of args) { dv.setUint32(pv, pb, true); pv += 4; u8.set(a, pb); pb += a.length; } return 0; },
    environ_sizes_get(pc, ps) { sync(); dv.setUint32(pc, envs.length, true); dv.setUint32(ps, envs.reduce((a, b) => a + b.length, 0), true); return 0; },
    environ_get(pv, pb) { sync(); for (const a of envs) { dv.setUint32(pv, pb, true); pv += 4; u8.set(a, pb); pb += a.length; } return 0; },
    clock_time_get(id, precision, ptr) { sync(); dv.setBigUint64(ptr, BigInt(Math.round((id === 0 ? Date.now() : performance.now()) * 1e6)), true); return 0; },
    clock_res_get(id, ptr) { sync(); dv.setBigUint64(ptr, 1000n, true); return 0; },
    random_get(ptr, n) { sync(); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u8.subarray(ptr + i, ptr + Math.min(n, i + 65536))); return 0; },
    proc_exit(code) { throw new Exit(code); },
    sched_yield() { return 0; },
    fd_prestat_get(fd, ptr) { if (fd !== 3) return E.BADF; sync(); dv.setUint8(ptr, 0); dv.setUint32(ptr + 4, 1, true); return 0; },
    fd_prestat_dir_name(fd, ptr) { if (fd !== 3) return E.BADF; sync(); u8[ptr] = 47; return 0; },
    fd_fdstat_get(fd, ptr) {
      const d = fds.get(fd); if (!d) return E.BADF;
      sync(); u8.fill(0, ptr, ptr + 24);
      dv.setUint8(ptr, d.type === "dir" ? FT.DIR : d.type === "file" ? FT.FILE : FT.CHAR);
      dv.setUint16(ptr + 2, d.append ? 1 : 0, true);
      dv.setBigUint64(ptr + 8, 0xffffffffffffffffn, true); dv.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_fdstat_set_flags(fd, flags) { const d = fds.get(fd); if (!d) return E.BADF; d.append = !!(flags & 1); return 0; },
    fd_filestat_get(fd, ptr) {
      const d = fds.get(fd); if (!d) return E.BADF;
      sync();
      if (d.type === "dir") filestat(ptr, d.path, FT.DIR, 0);
      else if (d.type === "file") filestat(ptr, d.path, FT.FILE, d.file.len);
      else { u8.fill(0, ptr, ptr + 64); dv.setUint8(ptr + 16, FT.CHAR); }
      return 0;
    },
    path_filestat_get(fd, flags, pp, pl, ptr) {
      sync();
      const p = resolve(fd, pp, pl); if (!p) return E.BADF;
      const f = files.get(p);
      if (f) filestat(ptr, p, FT.FILE, f.len); else if (dirs.has(p)) filestat(ptr, p, FT.DIR, 0); else return E.NOENT;
      return 0;
    },
    path_open(fd, dirflags, pp, pl, oflags, rightsBase, rightsInheriting, fdflags, pfd) {
      sync();
      const p = resolve(fd, pp, pl); if (!p) return E.BADF;
      let d;
      if (dirs.has(p)) {
        if (oflags & (O.CREAT | O.TRUNC) && !(oflags & O.DIRECTORY)) return E.ISDIR;
        d = { type: "dir", path: p };
      } else {
        let f = files.get(p);
        if (oflags & O.DIRECTORY) return f ? E.NOTDIR : E.NOENT;
        if (f && oflags & O.CREAT && oflags & O.EXCL) return E.EXIST;
        if (!f) { if (!(oflags & O.CREAT)) return E.NOENT; f = create(p); }
        else if (oflags & O.TRUNC) { if (f.ro) f = create(p); else f.len = 0; }
        d = { type: "file", path: p, file: f, pos: 0, append: !!(fdflags & 1) };
      }
      fds.set(nextFd, d); dv.setUint32(pfd, nextFd++, true); return 0;
    },
    fd_close(fd) { return fds.delete(fd) ? 0 : E.BADF; },
    fd_seek(fd, offset, whence, ptr) {
      const d = fds.get(fd); if (!d) return E.BADF;
      if (d.type !== "file") return E.SPIPE;
      const pos = Number(offset) + (whence === 0 ? 0 : whence === 1 ? d.pos : d.file.len);
      if (pos < 0) return E.INVAL;
      d.pos = pos; sync(); dv.setBigUint64(ptr, BigInt(pos), true); return 0;
    },
    fd_tell(fd, ptr) { const d = fds.get(fd); if (!d) return E.BADF; if (d.type !== "file") return E.SPIPE; sync(); dv.setBigUint64(ptr, BigInt(d.pos), true); return 0; },
    fd_read(fd, iovs, n, pn) { return read(fd, iovs, n, pn, null); },
    fd_pread(fd, iovs, n, offset, pn) { return read(fd, iovs, n, pn, Number(offset)); },
    fd_write(fd, iovs, n, pn) { return write(fd, iovs, n, pn, null); },
    fd_pwrite(fd, iovs, n, offset, pn) { return write(fd, iovs, n, pn, Number(offset)); },
    fd_sync() { return 0; },
    fd_datasync() { return 0; },
    fd_advise() { return 0; },
    fd_allocate() { return 0; },
    fd_filestat_set_times() { return 0; },
    path_filestat_set_times() { return 0; },
    fd_filestat_set_size(fd, size) {
      const d = fds.get(fd); if (!d || d.type !== "file") return E.BADF;
      if (d.file.ro) return E.ACCES;
      const n = Number(size);
      if (n > d.file.len) put(d.file, n, new Uint8Array(0)); else d.file.len = n;
      d.file.len = n; return 0;
    },
    // the entries of a directory, from the cookie-th on: lld and clang do not list directories in a build, but a
    // wrong answer would be worse than this one
    fd_readdir(fd, buf, len, cookie, pn) {
      sync();
      const d = fds.get(fd); if (!d || d.type !== "dir") return E.BADF;
      const p = d.path === "/" ? "/" : d.path + "/", names = new Map();
      for (const k of files.keys()) if (k.startsWith(p) && !k.includes("/", p.length)) names.set(k.slice(p.length), FT.FILE);
      for (const k of dirs) if (k !== "/" && k.startsWith(p) && !k.includes("/", p.length)) names.set(k.slice(p.length), FT.DIR);
      let used = 0, i = 0;
      for (const [name, type] of names) {
        if (i++ < Number(cookie)) continue;
        const nb = enc.encode(name), rec = new Uint8Array(24 + nb.length), r = new DataView(rec.buffer);
        r.setBigUint64(0, BigInt(i), true); r.setBigUint64(8, fs._ino(p + name), true); r.setUint32(16, nb.length, true); r.setUint8(20, type);
        rec.set(nb, 24);
        const k = Math.min(rec.length, len - used);
        u8.set(rec.subarray(0, k), buf + used); used += k;
        if (used >= len) break;
      }
      dv.setUint32(pn, used, true); return 0;
    },
    path_create_directory(fd, pp, pl) { sync(); const p = resolve(fd, pp, pl); if (!p) return E.BADF; if (files.has(p) || dirs.has(p)) return E.EXIST; fs.mkdir(p); return 0; },
    path_remove_directory(fd, pp, pl) { sync(); const p = resolve(fd, pp, pl); if (!p || !dirs.has(p)) return E.NOENT; if (fs.list(p).length) return E.NOTEMPTY; dirs.delete(p); return 0; },
    path_unlink_file(fd, pp, pl) { sync(); const p = resolve(fd, pp, pl); if (!p) return E.BADF; if (dirs.has(p)) return E.ISDIR; return files.delete(p) ? 0 : E.NOENT; },
    path_rename(fd, pp, pl, fd2, pp2, pl2) {
      sync();
      const a = resolve(fd, pp, pl), b = resolve(fd2, pp2, pl2); if (!a || !b) return E.BADF;
      const f = files.get(a); if (!f) return E.NOENT;
      if (dirs.has(b)) return E.ISDIR;
      fs._mkdirs(b); files.set(b, f); files.delete(a);
      for (const d of fds.values()) if (d.type === "file" && d.path === a) d.path = b;
      return 0;
    },
    path_readlink() { return E.INVAL; }, // there are no links
  };

  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.kind !== "function") continue;
    (imports[i.module] ??= {})[i.name] = (i.module === "wasi_snapshot_preview1" && wasi[i.name]) ||
      (() => { missing.add(i.module + "." + i.name); return E.NOSYS; });
  }
  const t0 = performance.now();
  let rc = 0, trap = "", bytes = 0;
  try {
    const instance = new WebAssembly.Instance(module, imports);
    memory = instance.exports.memory;
    try { instance.exports._start(); } finally { bytes = memory.buffer.byteLength; }
  } catch (e) {
    if (e instanceof Exit) rc = e.code;
    else { rc = -1; trap = "\n" + (argv.find((a) => a) || "wasm") + ": " + (e && e.message || e) + " (the compiler itself failed, not the source)\n"; }
  }
  let stderr = text(chunks[2]) + trap;
  if (missing.size && rc) stderr += "(not available in the browser: " + [...missing].join(", ") + ")\n";
  return { rc, stdout: text(chunks[1]), stderr, ms: Math.round(performance.now() - t0), memory: bytes };
}
