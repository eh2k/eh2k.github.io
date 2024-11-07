// The packs of the compiler (wasm/cc/*.pack.gz, made by machine/src_WASM/cc/pack.py): many small files in one
// download. A pack, gunzipped, is
//
//   "SCPACK1\n"                    8 bytes
//   length of the index            u32, little endian
//   the index                      JSON, UTF-8: { "name": ..., "files": [[path, size], ...] }
//   the files' bytes               one after the other, in the order of the index
//
// with absolute paths in the tree of the compiler (js/appbuild/toolchain.mjs: /app, /lib, /sysroot, /clang).
// mountPack() puts them into a file system of js/appbuild/wasi.mjs as views into the pack: nothing is copied, the
// pack has to stay as it is.

const MAGIC = "SCPACK1\n";

// -> { name, files: [[path, size], ...], bytes } (bytes: all files of the pack together); throws on anything else
export function mountPack(fs, pack) {
  if (!(pack instanceof Uint8Array)) pack = new Uint8Array(pack);
  if (pack.length < 12 || new TextDecoder().decode(pack.subarray(0, 8)) !== MAGIC)
    throw new Error("not a pack of the compiler (wasm/cc/*.pack.gz, gunzipped)");
  const n = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8, true);
  const index = JSON.parse(new TextDecoder().decode(pack.subarray(12, 12 + n)));
  let at = 12 + n;
  for (const [path, size] of index.files) {
    if (at + size > pack.length) throw new Error("the pack " + index.name + " is cut off at " + path);
    fs.mount(path, pack.subarray(at, at + size));
    at += size;
  }
  return { name: index.name, files: index.files, bytes: at - 12 - n };
}

// The apps' sources and lib/ straight from the repository instead of a lib.pack.gz: GitHub's tarball of a commit
// (gunzipped: ustar with pax headers, everything below one directory "<repo>-<commit>/") as a pack of the format
// above, with the files machine/src_WASM/cc/pack.py lib_pack() takes: the code of app/ (at most
// app/<GROUP>/<Name>/<file>) and of lib/, and lib/'s licence files, at /app/... and /lib/...
const CODE = /\.(h|hpp|hxx|inc|c|cc|cpp)$/;
const LICENCE = /^(LICEN[CS]E|COPYING|NOTICE)/i;

function libFile(rel) {
  if (rel.split("/").some((d) => d.startsWith(".") || d == "__pycache__"))
    return false;
  if (rel.startsWith("app/"))
    return CODE.test(rel) && rel.split("/").length <= 4;
  return rel.startsWith("lib/") && (CODE.test(rel) || LICENCE.test(rel.slice(rel.lastIndexOf("/") + 1)));
}

// the files of a tar: [[path, bytes], ...] (views into tar), the links to files as their targets' bytes. Long names
// come as pax records ("x": for the next entry; "g", the commit of GitHub's tarballs: skipped) or GNU "L" entries
export function tarFiles(tar) {
  const dec = new TextDecoder();
  const str = (at, n) => {
    const b = tar.subarray(at, at + n), z = b.indexOf(0);
    return dec.decode(z < 0 ? b : b.subarray(0, z));
  };
  const files = new Map(), links = [];
  let long = null;
  for (let at = 0; at + 512 <= tar.length;) {
    if (!tar[at]) // the end: blocks of zeros
      break;
    if (str(at + 257, 5) != "ustar")
      throw new Error("not a tar of the sources (no ustar header at " + at + ")");
    const size = parseInt(str(at + 124, 12).trim() || "0", 8);
    if (!(size >= 0) || at + 512 + size > tar.length)
      throw new Error("the tar of the sources is cut off");
    const type = String.fromCharCode(tar[at + 156] || 48);
    const body = tar.subarray(at + 512, at + 512 + size);
    const prefix = str(at + 345, 155);
    const name = long ?? (prefix ? prefix + "/" : "") + str(at, 100);
    const target = str(at + 157, 100);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type == "x") { // "<length> <key>=<value>\n" records
      for (let i = 0; i < body.length;) {
        const sp = body.indexOf(32, i), n = parseInt(dec.decode(body.subarray(i, sp)));
        if (!(n > 0))
          break;
        const rec = dec.decode(body.subarray(sp + 1, i + n - 1)), eq = rec.indexOf("=");
        if (rec.slice(0, eq) == "path")
          long = rec.slice(eq + 1);
        i += n;
      }
      continue;
    }
    if (type == "L") {
      long = dec.decode(body).replace(/\0+$/, "");
      continue;
    }
    long = null;
    if (type == "0" || type == "7")
      files.set(name, body);
    else if (type == "2" || type == "1")
      links.push([name, target, type]);
  }
  for (const [name, target, type] of links) { // a symlink's target is relative to its directory, a hard link's a path
    const parts = type == "1" ? [] : name.split("/").slice(0, -1);
    for (const p of target.split("/"))
      if (p == "..") parts.pop(); else if (p && p != ".") parts.push(p);
    const body = files.get(parts.join("/"));
    if (body)
      files.set(name, body);
  }
  return [...files];
}

// -> the pack "lib" (a Uint8Array for mountPack()) of a tarball of the repository; throws if it is not one
export function libPackFromTar(tar) {
  if (!(tar instanceof Uint8Array)) tar = new Uint8Array(tar);
  const entries = [];
  for (const [path, bytes] of tarFiles(tar)) {
    const rel = path.slice(path.indexOf("/") + 1); // without "<repo>-<commit>/"
    if (libFile(rel))
      entries.push(["/" + rel, bytes]);
  }
  if (!entries.some(([p]) => p == "/app/squares-and-circles-api.h"))
    throw new Error("the sources have no app/squares-and-circles-api.h");
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const files = entries.map(([p, b]) => [p, b.length]);
  const index = new TextEncoder().encode(JSON.stringify({ name: "lib", files }));
  const pack = new Uint8Array(12 + index.length + entries.reduce((n, [, b]) => n + b.length, 0));
  pack.set(new TextEncoder().encode(MAGIC));
  new DataView(pack.buffer).setUint32(8, index.length, true);
  pack.set(index, 12);
  let at = 12 + index.length;
  for (const [, b] of entries) {
    pack.set(b, at);
    at += b.length;
  }
  return pack;
}

// a .gz as the browser and node (18 and later) unpack it; js/appbuild/worker.js does this with the downloads
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
