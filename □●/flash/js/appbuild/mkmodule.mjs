// The post-processing of an app build, a JavaScript port of udynlink's mkmodule (machine/lib/udynlink/scripts/mkmodule
// process(), udynlink_utils.py): a linked ELF32 (--emit-relocs) -> the UDLM image the loader takes. No dependencies;
// runs under node and in a worker (Uint8Array in and out).
//  - gcc modules (code_before_data.ld, every datum through the LOT, R_ARM_GOT_BREL): bit-identical to mkmodule for
//    the same ELF (the apps of app/build.sh);
//  - clang modules (opts.clang: -fropi -frwpi, code_before_data_clang.ld, an empty LOT, r9 = the start of .data):
//    mkmodule has no such mode, its extension is in buildapp.mjs's header; here clangRelocs() (only R_ARM_ABS32 in
//    .data is left to the loader, everything else the linker resolved) and the names of the firmware's functions
//    without the stubs' prefix (EXT_PREFIX).
// Also the objcopy steps of mkmodule done on the bytes of an object, so that no objcopy is needed:
//   redefineSyms()  = objcopy --redefine-sym A=B ...   (rename_symbols(), uniquify_local_symbols())
//   uniquifyMap()   = the names uniquify_local_symbols() renames in object number idx
//   publicFunctions() = get_public_functions_in_object()
//   objcopy -L of the linked ELF is not needed: process() counts every global that is not public as a local.
// And prologueAsm() = asm_template.tmpl (Jinja2), wrappedName() = get_wrapped_name() (md5), globalSymbols() for the
// stubs of buildapp.mjs.

const SHT_SYMTAB = 2, SHT_RELA = 4, SHT_REL = 9, SHT_DYNSYM = 11;
const STB_LOCAL = 0, STB_GLOBAL = 1, STB_WEAK = 2, STT_FUNC = 2, STT_SECTION = 3, STT_FILE = 4;
// the names of pyelftools' describe_reloc_type() for the types a Thumb-2 object of gcc or clang can have
const R_ARM = {
  0: "R_ARM_NONE", 1: "R_ARM_PC24", 2: "R_ARM_ABS32", 3: "R_ARM_REL32", 5: "R_ARM_ABS16", 6: "R_ARM_ABS12",
  7: "R_ARM_THM_ABS5", 8: "R_ARM_ABS8", 9: "R_ARM_SBREL32", 10: "R_ARM_THM_CALL", 11: "R_ARM_THM_PC8",
  24: "R_ARM_GOTOFF32", 25: "R_ARM_BASE_PREL", 26: "R_ARM_GOT_BREL", 27: "R_ARM_PLT32", 28: "R_ARM_CALL",
  29: "R_ARM_JUMP24", 30: "R_ARM_THM_JUMP24", 31: "R_ARM_BASE_ABS", 38: "R_ARM_TARGET1", 40: "R_ARM_V4BX",
  41: "R_ARM_TARGET2", 42: "R_ARM_PREL31", 43: "R_ARM_MOVW_ABS_NC", 44: "R_ARM_MOVT_ABS", 45: "R_ARM_MOVW_PREL_NC",
  46: "R_ARM_MOVT_PREL", 47: "R_ARM_THM_MOVW_ABS_NC", 48: "R_ARM_THM_MOVT_ABS", 49: "R_ARM_THM_MOVW_PREL_NC",
  50: "R_ARM_THM_MOVT_PREL", 51: "R_ARM_THM_JUMP19", 52: "R_ARM_THM_JUMP6", 53: "R_ARM_THM_ALU_PREL_11_0",
  54: "R_ARM_THM_PC12", 55: "R_ARM_ABS32_NOI", 56: "R_ARM_REL32_NOI", 84: "R_ARM_MOVW_BREL_NC", 85: "R_ARM_MOVT_BREL",
  86: "R_ARM_MOVW_BREL", 87: "R_ARM_THM_MOVW_BREL_NC", 88: "R_ARM_THM_MOVT_BREL", 89: "R_ARM_THM_MOVW_BREL",
  96: "R_ARM_GOT_PREL", 102: "R_ARM_THM_JUMP11", 103: "R_ARM_THM_JUMP8", 104: "R_ARM_TLS_GD32", 107: "R_ARM_TLS_IE32",
  108: "R_ARM_TLS_LE32",
};
// a stub of a clang module is NAME and jumps through a slot whose R_ARM_ABS32 names __ext_NAME (buildapp.mjs
// stubsAsm()): the image's symbol table has it as NAME (mkmodule's out_name())
export const EXT_PREFIX = "__ext_";
const outName = (s) => (s.startsWith(EXT_PREFIX) ? s.slice(EXT_PREFIX.length) : s);
const hex = (n) => n.toString(16);
const SHN = { 0: "SHN_UNDEF", 0xfff1: "SHN_ABS", 0xfff2: "SHN_COMMON" };

const utf8 = new TextDecoder("utf-8");
const enc = new TextEncoder();

export class MkmoduleError extends Error {}
const error = (msg) => { throw new MkmoduleError(msg); };
const check = (cond, msg) => { if (!cond) error(msg); };

function cstr(u8, off) {
  let e = off;
  while (u8[e]) e++;
  return utf8.decode(u8.subarray(off, e));
}

export function parseElf(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  check(u8[0] == 0x7f && u8[1] == 0x45 && u8[2] == 0x4c && u8[3] == 0x46, "not an ELF file");
  check(u8[4] == 1 && u8[5] == 1, "not a little-endian ELF32");
  const shoff = dv.getUint32(0x20, true), shentsize = dv.getUint16(0x2e, true);
  const shnum = dv.getUint16(0x30, true), shstrndx = dv.getUint16(0x32, true);
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({
      index: i, hdr: o, nameoff: dv.getUint32(o, true), type: dv.getUint32(o + 4, true),
      addr: dv.getUint32(o + 12, true), offset: dv.getUint32(o + 16, true), size: dv.getUint32(o + 20, true),
      link: dv.getUint32(o + 24, true), info: dv.getUint32(o + 28, true), entsize: dv.getUint32(o + 36, true),
    });
  }
  for (const s of sections) s.name = cstr(u8, sections[shstrndx].offset + s.nameoff);
  const symbols = (sec) => { // of a symbol table section
    const str = sections[sec.link], out = [];
    for (let o = sec.offset; o + 16 <= sec.offset + sec.size; o += 16) {
      const st_name = dv.getUint32(o, true), info = u8[o + 12];
      out.push({
        at: o, st_name, name: cstr(u8, str.offset + st_name), value: dv.getUint32(o + 4, true),
        size: dv.getUint32(o + 8, true), bind: info >> 4, type: info & 15, shndx: dv.getUint16(o + 14, true),
      });
    }
    return out;
  };
  return { u8, dv, sections, symbols };
}

// udynlink_utils.get_symbols_in_elf(): by name, a later symbol of the same name replaces the values of the first
// but keeps its place (a Python dict, a JS Map alike)
function symbolsByName(elf) {
  const syms = new Map();
  for (const sec of elf.sections) {
    if (sec.type != SHT_SYMTAB && sec.type != SHT_DYNSYM) continue;
    for (const s of elf.symbols(sec))
      syms.set(s.name, { type: s.type, bind: s.bind, section: SHN[s.shndx] ?? s.shndx, value: s.value });
  }
  return syms;
}

// udynlink_utils.get_relocations_in_elf()
function relocations(elf) {
  const rels = [];
  for (const sec of elf.sections) {
    if (sec.type != SHT_REL && sec.type != SHT_RELA) continue;
    const symtab = elf.symbols(elf.sections[sec.link]);
    const ent = sec.type == SHT_REL ? 8 : 12;
    for (let o = sec.offset; o + ent <= sec.offset + sec.size; o += ent) {
      const info = elf.dv.getUint32(o + 4, true), si = info >>> 8;
      if (si == 0) continue;
      const sym = symtab[si], t = info & 255;
      rels.push({
        offset: elf.dv.getUint32(o, true), type: R_ARM[t] ?? "R_ARM_" + t,
        name: sym.st_name == 0 ? elf.sections[sym.shndx].name : sym.name, value: sym.value,
      });
    }
  }
  return rels;
}

function section(elf, name) {
  const s = elf.sections.find((x) => x.name == name);
  if (!s) error(`Section '${name}' not found`);
  return s;
}

// mkmodule's clang_relocs(): the relocations of a clang module. All but R_ARM_ABS32 in .data are resolved by the
// linker (PC-relative, or relative to the static base); returns the data relocations as mkmodule() keeps them,
// [name, word of .data, addend base]
const RESOLVED = new Set(["R_ARM_THM_CALL", "R_ARM_THM_JUMP24", "R_ARM_THM_JUMP19", "R_ARM_THM_JUMP11", "R_ARM_THM_JUMP8",
  "R_ARM_THM_MOVW_PREL_NC", "R_ARM_THM_MOVT_PREL", "R_ARM_THM_MOVW_BREL_NC", "R_ARM_THM_MOVT_BREL",
  "R_ARM_THM_MOVW_BREL", "R_ARM_SBREL32", "R_ARM_REL32", "R_ARM_THM_PC12", "R_ARM_THM_ALU_PREL_11_0",
  "R_ARM_THM_PC8", "R_ARM_NONE", "R_ARM_V4BX"]);
function clangRelocs(elf, cs, ds, bs) {
  const res = [];
  for (const sec of elf.sections) {
    if (sec.type != SHT_REL && sec.type != SHT_RELA) continue;
    const target = elf.sections[sec.info].name;
    if (target != ".text" && target != ".data") continue;
    const symtab = elf.symbols(elf.sections[sec.link]);
    const ent = sec.type == SHT_REL ? 8 : 12;
    for (let o = sec.offset; o + ent <= sec.offset + sec.size; o += ent) {
      const off = elf.dv.getUint32(o, true), info = elf.dv.getUint32(o + 4, true);
      const t = R_ARM[info & 255] ?? "R_ARM_" + (info & 255), sym = symtab[info >>> 8];
      const shndx = SHN[sym.shndx] ?? sym.shndx;
      const name = sym.st_name ? sym.name : (typeof shndx == "number" ? elf.sections[shndx].name : "?");
      if (RESOLVED.has(t)) {
        // resolved against a symbol the module does not have: only calls may (they go to a stub)
        check(shndx != "SHN_UNDEF" || sym.bind == STB_WEAK, `${t} against undefined '${name}' at ${hex(off)}`);
        if (t == "R_ARM_REL32")
          check(typeof shndx == "number" && elf.sections[shndx].name == target, `R_ARM_REL32 across sections ('${name}' at ${hex(off)})`);
        continue;
      }
      check(t == "R_ARM_ABS32" || t == "R_ARM_TARGET1", `Unknown relocation type '${t}' for symbol '${name}' at ${hex(off)}`);
      check(target == ".data", `R_ARM_ABS32 to '${name}' in read-only memory at ${hex(off)}: the loader can't relocate it ` +
        "(a constant that holds an address has to be writable data)");
      check(off % 4 == 0, `${name} offset ${hex(off)} is not a multiple of 4`);
      const idx = Math.floor((off - cs.size) / 4);
      if (shndx == "SHN_UNDEF") res.push([name, idx, 0]);
      else if (shndx == "SHN_ABS") continue;
      else if (shndx == cs.index) res.push([".text", idx, 0]);
      else {
        check(shndx == ds.index || shndx == bs.index, `R_ARM_ABS32 to '${name}' in section ${shndx}`);
        res.push([".data", idx, ds.addr]);
      }
    }
  }
  return res;
}

/** The UDLM image of a linked ELF.
 *  opts.name: module name (the engine names), opts.publicSymbols: iterable of names ([] = all globals),
 *  opts.localize: names objcopy -L would have made local (mkmodule's sym_renames values),
 *  opts.clang: a clang module (see the header), opts.warn: function(msg). Returns a Uint8Array. */
export function mkmodule(elfBytes, opts) {
  const elf = parseElf(elfBytes);
  const warn = opts.warn ?? (() => {});
  const publicSymbols = new Set(opts.publicSymbols ?? []);
  if (publicSymbols.size) publicSymbols.add("__init_array"); // as compile() does
  const localize = new Set(opts.localize ?? []);

  const cs = section(elf, ".text"), ds = section(elf, ".data"), bs = section(elf, ".bss");
  check(cs.size % 4 == 0, "Length of section '.text' is not a multiple of 4");
  check(cs.addr == 0, "Section '.text' doesn't start at address 0");
  const code = elfBytes.slice(cs.offset, cs.offset + cs.size);
  const codeDv = new DataView(code.buffer);
  check(ds.size % 4 == 0, "Length of section '.data' is not a multiple of 4");
  check(ds.addr == cs.size, "Section '.data' doesn't begin after section '.text'");
  const data = elfBytes.subarray(ds.offset, ds.offset + ds.size);
  const crtOff = cs.size + ds.size;
  check(bs.size % 4 == 0, "Length of section '.bss' is not a multiple of 4");
  check(bs.addr >= crtOff, "Section '.bss' doesn't begin after section '.data'");
  const bssSize = bs.addr + bs.size - crtOff;

  const syms = symbolsByName(elf), rels = opts.clang ? [] : relocations(elf);
  const symMap = new Map();
  for (const [s, d] of syms) {
    if (!s || s == "$t" || s == "$d") continue;
    if (d.bind == STB_GLOBAL && !localize.has(s)) {
      const defined = d.section != "SHN_UNDEF";
      symMap.set(s, defined ? (publicSymbols.size == 0 || publicSymbols.has(s) ? "exported" : "local") : "external");
    } else {
      if (d.type == STT_FILE) continue;
      symMap.set(s, "local");
    }
  }
  const kind = (s) => symMap.get(s) ?? error(`Symbol '${s}' is not in the symbol map`);

  // LOT relocations
  const localRelocs = [], foreignRelocs = [], rlist = [], ignored = new Set();
  for (const r of rels) {
    const s = r.name, t = r.type;
    if (!syms.has(s)) {
      if (!ignored.has(s)) { warn(`Ingoring unknown symbol '${s}' in relocation list`); ignored.add(s); }
      continue;
    }
    const value = syms.get(s).value;
    if (t == "R_ARM_THM_CALL" || t == "R_ARM_THM_JUMP24") continue;
    if (t == "R_ARM_GOT_BREL") {
      const k = kind(s);
      (k == "external" ? foreignRelocs : localRelocs).push([s, r.offset, value]);
      rlist.push(r);
    } else if (t != "R_ARM_ABS32" && t != "R_ARM_TARGET1") error(`Unknown relocation type '${t}' for symbol '${s}'`);
  }
  const relocIdx = new Map();
  let lotEntries = 0;
  for (const e of rlist) if (!relocIdx.has(e.name)) relocIdx.set(e.name, lotEntries++);

  // data relocations (R_ARM_ABS32)
  const dataRelocs = [], dataKeys = new Set();
  const key = (r) => JSON.stringify(r); // mkmodule tests tuples for membership by value
  for (const r of rels) {
    if (r.type != "R_ARM_ABS32" && r.type != "R_ARM_TARGET1") continue;
    const s = r.name;
    check(r.offset % 4 == 0, `${s} offset mod 4 '${r.offset.toString(16)}' is not a multiple of 4`);
    const off = (r.offset - code.length) / 4;
    check(off >= 0, `Offset of R_ARM_ABS32 symbols '${s}' should be positive or 0!`);
    const t = [s, lotEntries + off, r.value];
    dataRelocs.push(t);
    dataKeys.add(key(t));
    if (s != ".data" && !relocIdx.has(s)) relocIdx.set(s, lotEntries + off);
  }

  if (opts.clang) {
    for (const t of clangRelocs(elf, cs, ds, bs)) {
      dataRelocs.push(t);
      dataKeys.add(key(t));
      if (t[0] != ".data" && t[0] != ".text" && !relocIdx.has(t[0])) relocIdx.set(t[0], 0);
    }
  }

  for (const [sym, offset] of [...localRelocs, ...foreignRelocs]) codeDv.setUint32(offset, relocIdx.get(sym) * 4, true);

  // symbol table: the module name, the public symbols (sorted), then the others in the order they are needed
  const inAll = (s) => symMap.has(s) && (relocIdx.has(s) || symMap.get(s) == "external" || symMap.get(s) == "exported");
  const slist = [opts.name], symtIdx = new Map();
  const symIndex = (s) => {
    if (symtIdx.has(s)) return symtIdx.get(s);
    if (!inAll(s)) error(`Unknown symbol '${s}'`);
    slist.push(s);
    symtIdx.set(s, slist.length - 1);
    return slist.length - 1;
  };
  if (publicSymbols.size == 0) { for (const s of symMap.keys()) if (inAll(s)) symIndex(s); }
  else for (const s of [...publicSymbols].sort()) if (symMap.has(s)) symIndex(s);

  const out = [];
  const u32 = (...v) => { for (const x of v) out.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255); };
  const u16 = (x) => { check(x >= 0 && x <= 0xffff, "more than 65535 LOT entries or relocations"); out.push(x & 255, x >>> 8); };

  const relocated = new Set(), relocWords = [];
  const fromData = (i) => i >= localRelocs.length + foreignRelocs.length;
  [...localRelocs, ...foreignRelocs, ...dataRelocs].forEach((r, i) => {
    const sym = r[0];
    let offset = r[1], value = r[2];
    if (sym == ".text") value = ((1 << 30) | value) >>> 0;
    else if (sym == ".data") value = ((1 << 31) | value) >>> 0;
    else {
      if (!(fromData(i) || dataKeys.has(key(r)))) offset = relocIdx.get(sym);
      value = symIndex(sym);
      if (relocated.has(`${sym}${offset}${value}`)) return;
    }
    relocated.add(`${sym}${offset}${value}`);
    relocWords.push(offset, value);
  });

  const names = slist.map((s, i) => (i == 0 || symMap.get(s) != "local" ? enc.encode(i == 0 ? s : outName(s)) : null));
  let symtLen = slist.length * 8 + 4;
  for (const n of names) if (n) symtLen += n.length + 1;
  symtLen = (symtLen + 3) & ~3;

  out.push(0x55, 0x44, 0x4c, 0x4d); // "UDLM"
  u16(lotEntries);
  u16(relocWords.length / 2);
  u32(symtLen, code.length, data.length, bssSize);
  u32(...relocWords);
  u32(slist.length);
  let off = slist.length * 8 + 4;
  slist.forEach((s, i) => {
    if (i == 0) u32(((3 << 28) | off) >>> 0, 0);
    else {
      const k = symMap.get(s), d = syms.get(s);
      const sec = typeof d.section == "number" ? elf.sections[d.section] : null;
      if (!sec && d.section != "SHN_UNDEF") error(`Symbol '${s}' is in ${d.section}`);
      const inCode = !!sec && sec.index == cs.index;
      if (sec && !inCode && sec.index != ds.index && sec.index != bs.index) error(`Symbol '${s}' is in section '${sec.name}'`);
      const type = (k == "local" ? 0 : k == "exported" ? 1 : 2) | (inCode ? 4 : 0);
      const val = d.value - (k == "external" || inCode ? 0 : code.length);
      check(val >= 0, `Symbol '${s}' lies before .data`);
      u32(((k != "local" ? off : 0) | (type << 28)) >>> 0, val);
    }
    if (names[i]) off += names[i].length + 1;
  });
  for (const n of names) if (n) { out.push(...n); out.push(0); }
  while (out.length % 4) out.push(0);

  const img = new Uint8Array(out.length + code.length + data.length);
  img.set(out);
  img.set(code, out.length);
  img.set(data, out.length + code.length);
  return img;
}

// ---- the objcopy steps, on a relocatable object -----------------------------------------------------------------

/** objcopy --redefine-sym old=new for every entry of map (Map or object): the new names are appended to the string
 *  table, which moves to the end of the file. Returns a new Uint8Array. */
export function redefineSyms(objBytes, map) {
  const m = map instanceof Map ? map : new Map(Object.entries(map));
  const elf = parseElf(objBytes);
  const symtab = elf.sections.find((s) => s.type == SHT_SYMTAB);
  if (!symtab || m.size == 0) return objBytes.slice();
  const str = elf.sections[symtab.link];
  const add = [], patches = [], seen = new Map();
  let pos = str.size;
  for (const s of elf.symbols(symtab)) {
    if (!s.st_name || !m.has(s.name)) continue;
    const nn = m.get(s.name);
    if (!seen.has(nn)) { const b = enc.encode(nn); seen.set(nn, pos); add.push(b); pos += b.length + 1; }
    patches.push([s.at, seen.get(nn)]);
  }
  const start = (objBytes.length + 3) & ~3;
  const out = new Uint8Array(start + pos);
  out.set(objBytes);
  out.set(objBytes.subarray(str.offset, str.offset + str.size), start);
  let p = start + str.size;
  for (const b of add) { out.set(b, p); p += b.length + 1; }
  const dv = new DataView(out.buffer);
  for (const [at, nameoff] of patches) dv.setUint32(at, nameoff, true);
  dv.setUint32(str.hdr + 16, start, true);
  dv.setUint32(str.hdr + 20, pos, true);
  return out;
}

/** The defined and the undefined names of an object's symbols that are not local, as mkmodule's clang_stubs() sorts
 *  them (get_symbols_in_elf(): by name, the last symbol of a name counts). */
export function globalSymbols(objBytes) {
  const defined = new Set(), undefined_ = new Set();
  for (const [s, d] of symbolsByName(parseElf(objBytes))) {
    if (!s || d.bind == STB_LOCAL) continue;
    (d.section == "SHN_UNDEF" ? undefined_ : defined).add(s);
  }
  return { defined, undefined: undefined_ };
}

/** get_public_functions_in_object(): the global functions of an object. */
export function publicFunctions(objBytes) {
  const elf = parseElf(objBytes), out = new Set();
  for (const sec of elf.sections) if (sec.type == SHT_SYMTAB)
    for (const s of elf.symbols(sec)) if (s.type == STT_FUNC && s.bind == STB_GLOBAL) out.add(s.name);
  return [...out];
}

/** uniquify_local_symbols(): the rename map of object number idx (name -> name.o<idx>). */
export function uniquifyMap(objBytes, idx) {
  const elf = parseElf(objBytes), m = new Map();
  const symtab = elf.sections.find((s) => s.type == SHT_SYMTAB);
  for (const s of symtab ? elf.symbols(symtab) : []) {
    if (s.bind != STB_LOCAL || s.type == STT_FILE || s.type == STT_SECTION) continue;
    if (s.name && !s.name.startsWith("$")) m.set(s.name, `${s.name}.o${idx}`);
  }
  return m;
}

// ---- md5 (get_wrapped_name) and the prologue template -----------------------------------------------------------

function md5hex(bytes) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  const len = bytes.length, n = ((len + 8) >> 6) + 1, w = new Uint32Array(n * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i & 3) * 8);
  w[len >> 2] |= 0x80 << ((len & 3) * 8);
  w[n * 16 - 2] = len * 8;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < w.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      f = (f + a + K[i] + w[o + g]) | 0;
      const s = S[(i >> 4) * 4 + (i & 3)];
      a = d; d = c; c = b;
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].map((x) => [0, 8, 16, 24].map((s) => ((x >>> s) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

/** get_wrapped_name(): __<first 9 hex digits of md5(name)>__name */
export const wrappedName = (n) => `__${md5hex(enc.encode(n)).slice(0, 9)}__${n}`;

/** asm_template.tmpl for a rename map {public name: wrapped name} (the same text Jinja2 renders). */
export function prologueAsm(renames) {
  let s = "    .syntax unified\n    .arch armv7-m\n\n    .text\n    .thumb\n\n";
  for (const [n, act] of Object.entries(renames))
    s += `    .section .text_nogc, "x"\n    .balign 4\n    .thumb_func\n    .globl ${n}\n    .type ${n}, %function\n` +
      `    .extern ${act}\n    .type ${act}, %function\n${n}:\n    push    {r9, lr}\n    push    {r1}\n` +
      `    ldr.w   r1, .L1${n}\n    ldr     r9, [r1]\n    pop     {r1}\n    bl      ${act}\n    pop     {r9, pc}\n\n` +
      `    .balign 4\n.L1${n}:\n    .word   0x20000000\n    .size   ${n}, . - ${n}\n`;
  return s + "\n    .end\n";
}
