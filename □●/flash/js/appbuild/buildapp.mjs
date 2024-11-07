// An app (app/<GROUP>/<Name>/<Name>.cpp) built to the .bin the firmware loads, with clang and lld as the only
// tools: everything of app/build.sh and of udynlink's mkmodule around the compiler, for the tab (a worker) and
// node. The toolchain is given (toolchain.mjs: clang and ld.lld as WebAssembly on a file tree in memory), so this
// file has no dependency but its neighbours and runs synchronously.
//
//   buildApp(tc, { source, name, files }) -> { ok: true, bin, engines, warnings } | { ok: false, error }
//     name    "GROUP/Name": the app's place in the tree, /app/<GROUP>/<Name>/<Name>.cpp, and its engine's name if
//             the source has no ENGINE_NAME
//     files   further files of the app beside its source, { "relative/path.h": text or Uint8Array }
//     tc.fs   readFile(path) -> Uint8Array | null, writeFile(path, Uint8Array | string), exists(path), unlink(path):
//             absolute paths, the tree's root is the checkout's (/app/squares-and-circles-api.h, /lib/...)
//     tc.run(tool, argv, { cwd }) -> { rc, stdout, stderr }: tool "clang" (runs the jobs of its driver) or "ld.lld"
//     tc.SYSROOT_ARGS  clang's arguments for the headers (--sysroot=, -isystem ..., -resource-dir ...). An -isystem
//             whose directory has "/c++/" in it is libstdc++'s: only C++ sources get those (its math.h and stdlib.h
//             are C++), after -x c++ as mkmodule has them
//   It never throws: every way to fail is { ok: false, error } with a text for the one who wrote the source (the
//   compiler's diagnostics as clang printed them, a symbol the firmware does not have by name, ...).
//
// app/build.sh builds with arm-none-eabi-gcc: -fPIE -msingle-pic-base -mno-pic-data-is-text-relative, every datum
// through an entry of the LOT (r9), which clang does not have. Here the module is clang's -fropi -frwpi: code and
// constants PC-relative, writable data relative to r9, with an EMPTY LOT: the loader puts .data right after the LOT
// and r9 at the LOT, so r9 is the start of .data, clang's static base. The loader and the firmware are the same.
// What that model cannot do is done around clang's code generation (the steps of mkmodule's compile(), link() and
// process(), in their order, so that the image is the one the Python gives with the same tools):
//   1. clang -S -emit-llvm: the source to optimized LLVM IR (text);
//   2. irfix.mjs: address constants become writable data, the firmware's data goes through slots __imp_<name>;
//   3. clang -x ir -Xclang -disable-llvm-passes: code generation only;
//   4. the public functions (setup, process, draw, ...) are renamed to __<md5>__<name>, a prologue under the
//      public name sets r9 and calls it (mkmodule.mjs prologueAsm(), as for gcc);
//   5. a stub per firmware function the app calls: the app's objects call NAME, the stub is NAME and jumps through
//      the slot __imp_NAME, whose R_ARM_ABS32 names __ext_NAME (the image's symbol table has NAME); thunks from the
//      ARM run-time ABI's memory helpers, which clang calls and the firmware does not export, to its memcpy,
//      memmove and memset;
//   6. ld.lld with a linker script that gives .data and .bss a segment of their own (the linker's static base is
//      the segment's start), --emit-relocs; mkmodule.mjs mkmodule() writes the image from the ELF.
// Flags: -meabi gnu (no __aeabi_mem* where clang can call memcpy; in both runs), -fshort-enums (gcc's enums on this
// target), -Xclang -cl-single-precision-constant (gcc's -fsingle-precision-constant), -fno-builtin-pow (no exp2()
// for pow(2, x)), -fno-c++-static-destructors (no atexit). The app's own "build_flags:" line replaces the float
// flags, "src_files:" names further sources (from the tree, e.g. lib/rb303/rb303.c), as in app/build.sh.
//
// machine/src_WASM/cc/test/post_test.mjs compares the images with those of the Python for all apps.

import { mkmodule, redefineSyms, publicFunctions, uniquifyMap, wrappedName, prologueAsm, globalSymbols, EXT_PREFIX,
  MkmoduleError } from "./mkmodule.mjs";
import { fixIR, LINKER_SYMS, IrError } from "./irfix.mjs";
import { WHITELIST } from "./whitelist.mjs";

const TARGET = ["--target=thumbv7em-none-eabihf", "-mcpu=cortex-m7", "-mthumb"];
const DEFAULT_FLAGS = "-mfloat-abi=hard -mfpu=fpv5-d16 -ffast-math"; // app/build.sh without a build_flags line
const CLANG_EXTRA = ["-meabi", "gnu", "-fshort-enums", "-Xclang", "-cl-single-precision-constant", "-fno-builtin-pow"];
const CODEGEN_EXTRA = ["-meabi", "gnu"];
const PUBLIC_SYMBOLS = ["setup", "process", "draw", "screensaver", "restore", "__ui_event_handler",
  "__midi_event_handler", "__engine_alias", "__engine_aliases", "__insert_fx"];
const MAX_TEXT = 16000; // of the diagnostics in a result
const NAME = /^[A-Za-z0-9_+@!-][A-Za-z0-9_.+@!-]*\/[A-Za-z0-9_+@!-][A-Za-z0-9_.+@!-]*$/;
// what a build writes beside the source: an app's own file may not have such a name
const RESERVED = /^(cpp_init_fini\.c|aliases\.c|module\.ld|__stubs\.s|.*\.(o|ll|elf|i)|.*_prologue\.s)$/;

// machine/lib/udynlink/scripts/cpp_init_fini.c: __init_array() runs the constructors of the module's globals
const CPP_INIT_FINI = `#include <sys/types.h>

extern void (*__preinit_array_start[])(void) __attribute__((weak));
extern void (*__preinit_array_end[])(void) __attribute__((weak));
extern void (*__init_array_start[])(void) __attribute__((weak));
extern void (*__init_array_end[])(void) __attribute__((weak));

void __init_array(void)
{
  size_t n;
  size_t i;

  n = __preinit_array_end - __preinit_array_start;
  for (i = 0; i < n; i++)
    __preinit_array_start[i]();

  n = __init_array_end - __init_array_start;
  for (i = 0; i < n; i++)
    __init_array_start[i]();
}`;

// code_before_data.ld of udynlink for clang's ROPI/RWPI modules: .data and .bss get a PT_LOAD of their own, so the
// linker's static base (R_ARM_SBREL32, R_ARM_THM_MOVW/MOVT_BREL: the address of the segment's first section) is
// the start of .data, which is where r9 points with an empty LOT
const LINKER_SCRIPT = `PHDRS
{
  text PT_LOAD;
  data PT_LOAD;
}
MEMORY
{
  all                   (RWX) : ORIGIN = 0x00000000, LENGTH = 0xFFFFFFFF
}
SECTIONS
{
  .text :
  {
    . = ALIGN(4);
    KEEP(*(.text_nogc))
    *(.text)
    *(.text*)
    *(.rodata)
    *(.rodata*)
    . = ALIGN(8);
  } > all :text

  .data :
  {
    . = ALIGN(4);
    *(.data)
    *(.data*)
    . = ALIGN(4);
    KEEP(*(.init))
    __preinit_array_start = .;
    KEEP (*(.preinit_array))
    __preinit_array_end = .;
    __init_array_start = .;
    KEEP (*(.init_array))
    __init_array_end = .;
    . = ALIGN(4);
  } > all :data

  .bss :
  {
    . = ALIGN(4);
    *(.bss)
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
  } > all :data

  /DISCARD/ : { *(.ARM.exidx*) *(.ARM.extab*) *(.ARM.attributes) *(.comment) *(.note*) }
}
`;

// a failed build: its message is the result's error
class BuildError extends Error {}
const fail = (msg) => { throw new BuildError(msg); };

const utf8 = new TextDecoder("utf-8");
const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p) => { const b = basename(p), i = b.lastIndexOf("."); return dirname(p) + "/" + (i > 0 ? b.slice(0, i) : b); };
const isCxx = (p) => p.endsWith(".cpp") || p.endsWith(".cxx");

// "." and ".." resolved; null for a path that leaves the root
function normalize(p) {
  const out = [];
  for (const s of p.split("/")) {
    if (s == "" || s == ".") continue;
    if (s == "..") { if (!out.length) return null; out.pop(); } else out.push(s);
  }
  return "/" + out.join("/");
}

// app/build.sh: grep "build_flags:" | cut -d':' -f2- | xargs, and grep "src_files" | cut -d':' -f2 | xargs (xargs:
// the words of all such lines, quotes dropped)
function magic(source, key, rest) {
  const words = [];
  for (const l of source.split("\n")) {
    if (!l.includes(key)) continue;
    const f = l.split(":");
    if (f.length < 2) continue;
    for (const w of (rest ? f.slice(1).join(":") : f[1]).split(/\s+/)) if (w) words.push(w.replace(/["'\\]/g, ""));
  }
  return words.filter((w) => w);
}

// ---- the engines' names and aliases, from the preprocessor's output ------------------------------------------------

// app/build.sh: sed -n 's/.*__engine_names_fit("\([^"]*\)").*/\1/p' (the last one of a line), the lines joined with
// ';': what ENGINE_NAME("A;B") leaves, the module's name in the image
export function engineNames(pre) {
  const names = [];
  for (const l of pre.split("\n")) {
    const m = [...l.matchAll(/__engine_names_fit\("([^"]*)"\)/g)];
    if (m.length) names.push(m[m.length - 1][1]);
  }
  return names.join(";");
}

// app/engine_aliases.py: the ENGINE_ALIAS and ENGINE_INSERT_FX lines of the app as constants of its binary, the
// text of a C source or null without an alias and a mark. From the preprocessor output, in its order:
// ENGINE_NAME("A;B") adds its engines, ENGINE_ALIAS("OLD"[, "LAYOUT"]) and ENGINE_INSERT_FX() belong to the engine
// before them (to the first one without one before them). __engine_alias: the first alias of each engine, ';'
// between the engines; __engine_aliases: all of them, '|' between the aliases of one, OLD=LAYOUT with the old
// parameters' layout; __insert_fx: a letter per engine, '1' marked.
export function engineAliases(pre) {
  const TOKEN = /__engine_names_fit\("([^"]*)"\)|__engine_alias_fits\("([^"]*)"(?:\s*,\s*"([^"]*)")?\)|(__engine_insert_fx\("INSERT-FX"\))/g;
  const engines = [], inserts = [];
  let pending = [], pendingInsert = false; // before the first ENGINE_NAME: the first engine's
  for (const [, names, old, layout, insert] of pre.matchAll(TOKEN)) {
    if (names !== undefined) {
      for (let i = names.split(";").length; i > 0; i--) { engines.push([]); inserts.push(false); }
      if (pending.length || pendingInsert) {
        engines[0].unshift(...pending);
        inserts[0] ||= pendingInsert;
        pending = [];
        pendingInsert = false;
      }
    } else if (insert !== undefined) {
      if (inserts.length) inserts[inserts.length - 1] = true; else pendingInsert = true;
    } else (engines.length ? engines[engines.length - 1] : pending).push(old + (layout ? "=" + layout : ""));
  }
  if ((pending.length || pendingInsert) && !engines.length) { // no ENGINE_NAME: one engine, CATEGORY/FileName
    engines.push(pending);
    inserts.push(pendingInsert);
  }
  const any = engines.some((a) => a.length), anyInsert = inserts.some((i) => i);
  if (!any && !anyInsert) return null;
  const constant = (name, value) =>
    `__attribute__((used, section(".text_nogc"), aligned(4))) const char ${name}[${(value.length + 1 + 3) & ~3}] = "${value}";\n`;
  let c = "// app/engine_aliases.py from the ENGINE_ALIAS and ENGINE_INSERT_FX lines of the app\n";
  if (any) {
    c += constant("__engine_alias", engines.map((a) => (a.length ? a[0].split("=")[0] : "")).join(";"));
    c += constant("__engine_aliases", engines.map((a) => a.join("|")).join(";"));
  }
  if (anyInsert) c += constant("__insert_fx", inserts.map((i) => (i ? "1" : "0")).join(""));
  return c;
}

// ---- the stubs of the firmware's functions ---------------------------------------------------------------------------

// mkmodule's clang_stubs(): from the objects' symbols the assembly of the thunks and stubs (see the header), null
// if there are none. externData: the firmware's data symbols (irfix.mjs: they have slots already, no stub).
// Returns { asm, names: the firmware functions called }.
export function stubsAsm(objects, externData) {
  const defined = new Set(), undefined_ = new Set();
  for (const o of objects) {
    const g = globalSymbols(o);
    for (const s of g.defined) defined.add(s);
    for (const s of g.undefined) undefined_.add(s);
  }
  let thunks = "";
  for (const n of [...undefined_].filter((s) => !defined.has(s)).sort()) {
    const m = /^__aeabi_(memcpy|memmove|memset|memclr)[48]?$/.exec(n);
    if (!m) continue;
    // __aeabi_memset: (dest, n, c), __aeabi_memclr: (dest, n)
    const to = m[1] == "memclr" ? "memset" : m[1];
    const swap = m[1] == "memset" ? "    mov     r3, r1\n    mov     r1, r2\n    mov     r2, r3\n" :
      m[1] == "memclr" ? "    mov     r2, r1\n    movs    r1, #0\n" : "";
    thunks += `
    .section .text.${n}, "ax", %progbits
    .balign 4
    .thumb_func
    .globl ${n}
    .type ${n}, %function
${n}:
${swap}    b.w     ${to}
    .size ${n}, . - ${n}
`;
    defined.add(n);
    undefined_.add(to);
  }
  const names = [...undefined_].filter((s) => !defined.has(s) && !LINKER_SYMS.has(s) && !externData.has(s)).sort();
  if (!names.length && !thunks) return { asm: null, names };
  let asm = "    .syntax unified\n    .thumb\n    .eabi_attribute 14, 1\n" + thunks;
  for (const n of names)
    asm += `
    .section .text.__stub.${n}, "ax", %progbits
    .balign 4
    .thumb_func
    .globl ${n}
    .type ${n}, %function
${n}:
    movw    r12, #:lower16:__imp_${n}(sbrel)
    movt    r12, #:upper16:__imp_${n}(sbrel)
    ldr.w   r12, [r9, r12]
    bx      r12
    .size ${n}, . - ${n}
    .section .data.__imp_${n}, "aw", %progbits
    .balign 4
    .type __imp_${n}, %object
__imp_${n}:
    .word   ${EXT_PREFIX}${n}
    .size __imp_${n}, 4
`;
  return { asm, names };
}

// what to tell about symbols the firmware does not have
function unresolved(names) {
  const hints = [];
  if (names.some((n) => n.startsWith("__aeabi_") || /^__(u?div|u?mod|mul|fix|float|ashl|lshr|ashr)/.test(n)))
    hints.push("__aeabi_* and the like are the compiler's helpers for what the CPU has no instruction for: 64-bit " +
      "division, double arithmetic with -mfloat-abi=soft. Use float and 32-bit integers (see app/CLAUDE.md)");
  if (names.some((n) => /^(a?(sin|cos|tan)h?|atan2|exp(2|m1)?|log(2|10|1p)?|pow|sqrt|cbrt|hypot|floor|ceil|round|trunc|l?l?rint|fmod|fabs|ldexp|frexp|modf)$/.test(n)))
    hints.push("of math.h the firmware has the float functions (sinf, powf, floorf, ...) and only a few of the double " +
      "ones: a double argument, e.g. a literal without f in a .c source, calls the double one");
  if (names.includes("__aeabi_read_tp")) hints.push("thread_local variables are not available: use a plain global");
  if (names.some((n) => /^(__cxa_|_ZSt|_ZNSt|__gxx_|_Unwind_|__dso_handle|atexit)/.test(n)))
    hints.push("no C++ run-time library: no exceptions, no RTTI, no std containers that allocate or throw");
  return "the firmware has no symbol " + names.map((n) => `'${n}'`).join(", ") + ": the app would not load on the " +
    "module. An app can only use what squares-and-circles-api.h declares and the functions the firmware exports." +
    hints.map((h) => "\n" + h).join("");
}

// ---- clang's diagnostics -----------------------------------------------------------------------------------------

// The diagnostics of a clang run that are worth their place: every error, and the warnings whose place is in the
// app's own directory (-pedantic has many for the headers of lib/, which the author of the app cannot change). A
// diagnostic is its "In file included from" lines, the line "path:line:col: kind: text" and what follows up to the
// next one (the source line, the caret, its notes).
function diagnostics(stderr, appDir) {
  const START = /^(.+?):\d+:(?:\d+:)? (warning|error|fatal error|note): /;
  const blocks = [];
  let cur = null, pre = [];
  for (const l of stderr.split("\n")) {
    if (/^\d+ (warning|error)s?( and \d+ errors?)? generated\.$/.test(l)) continue;
    if (/^In file included from /.test(l) || /^\s+from .*:\d+[:,]$/.test(l)) { pre.push(l); continue; }
    const m = START.exec(l);
    if (m && m[2] != "note") {
      if (cur) blocks.push(cur);
      cur = { path: m[1], kind: m[2], lines: [...pre, l] };
    } else if (cur && (m || !pre.length)) cur.lines.push(...pre, l); // a note, the source line, the caret
    else if (l.trim()) { // a line of no located diagnostic ("clang: error: ...", the linker's)
      if (cur) blocks.push(cur);
      cur = { path: "", kind: /\bwarning:/.test(l) ? "warning" : "error", lines: [...pre, l] };
    } else continue;
    pre = [];
  }
  if (cur) blocks.push(cur);
  const keep = blocks.filter((b) => b.kind != "warning" || b.path.startsWith(appDir + "/"));
  let text = keep.map((b) => b.lines.join("\n").trimEnd()).join("\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n... (cut)";
  return text;
}

// ---- the build -------------------------------------------------------------------------------------------------------

/** See the header. */
export function buildApp(tc, { source, name, files = {} } = {}) {
  const written = new Set(); // what this build wrote into the tree: gone at its end
  const fs = {
    write(p, d) { written.add(p); tc.fs.writeFile(p, d); },
    read(p) { return tc.fs.readFile(p) ?? fail(`internal error: the file ${p} is missing`); },
    text(p) { return utf8.decode(this.read(p)); },
  };
  try {
    if (typeof source != "string" || !source.trim()) fail("no source: build_app needs the text of the app's .cpp");
    if (typeof name != "string" || !NAME.test(name))
      fail(`the name '${name}' is not GROUP/Name (letters, digits and _ + - . @ !), e.g. "SYNTH/MyOsc"`);
    const [group, app] = name.split("/");
    const dir = `/app/${group}/${app}`, src = `${dir}/${app}.cpp`;
    let warnings = "";

    // one run of a tool; a failure is the build's, with what the tool printed
    const run = (tool, argv, what) => {
      const o = argv.lastIndexOf("-o");
      if (o >= 0) written.add(argv[o + 1]);
      const r = tc.run(tool, argv, { cwd: "/" });
      const err = (r.stderr ?? "") + (tool == "clang" ? "" : r.stdout ?? "");
      if (r.rc != 0) fail(diagnostics(err, dir) || `${what}: ${tool} failed (${r.rc})\n${err}`.trim());
      if (tool == "clang" && what == "app") {
        const w = diagnostics(err, dir);
        if (w) warnings += (warnings ? "\n" : "") + w;
      }
      return r;
    };

    fs.write(src, source);
    for (const [rel, data] of Object.entries(files ?? {})) {
      const p = normalize(dir + "/" + rel);
      if (rel.startsWith("/") || !p || !p.startsWith(dir + "/") || p == src || RESERVED.test(basename(p)))
        fail(`files: '${rel}' is not a path for a file of the app (relative, in its directory, not ${app}.cpp, not a ` +
          "name the build writes: *.o, *.ll, *.elf, *.i, aliases.c, cpp_init_fini.c)");
      if (typeof data != "string" && !(data instanceof Uint8Array)) fail(`files: '${rel}' is neither text nor bytes`);
      fs.write(p, data);
    }

    const buildFlags = magic(source, "build_flags:", true);
    const floatFlags = buildFlags.length ? buildFlags : DEFAULT_FLAGS.split(" ");
    const srcFiles = magic(source, "src_files", false).map((f) => {
      const p = normalize("/" + f);
      if (!p || !tc.fs.exists(p)) fail(`src_files: '${f}' is not a file of the tree (paths from its root, e.g. lib/rb303/rb303.c)`);
      return p;
    });
    const sys = tc.SYSROOT_ARGS ?? [], sysC = [], sysCxx = [];
    for (let i = 0; i < sys.length; i++) {
      if (sys[i] == "-isystem" && /\/c\+\+(\/|$)/.test(sys[i + 1] ?? "")) sysCxx.push(sys[i], sys[++i]);
      else if (sys[i] == "-isystem" || sys[i] == "-resource-dir") sysC.push(sys[i], sys[++i]);
      else sysC.push(sys[i]);
    }
    // mkmodule's clang_flags(): the arguments of a source's first run, for C++ or C
    const flags = (cxx) => {
      const f = [...TARGET, "-DNDEBUG", "-pedantic", "-fno-exceptions", ...floatFlags, "-I.", "-I./lib/",
        "-ffunction-sections", "-fdata-sections", "-fropi", "-frwpi", "-fallow-unsupported", "-fomit-frame-pointer",
        "-fno-unwind-tables", "-fno-asynchronous-unwind-tables", "-O3", ...CLANG_EXTRA, ...sysC];
      return cxx ? [...f, "-fno-use-cxa-atexit", "-fno-c++-static-destructors", "-fno-exceptions", "-fno-rtti", "-x", "c++", ...sysCxx] :
        [...f.filter((x) => !x.startsWith("-std=")), "-x", "c"];
    };

    // the engines' names and aliases: from the preprocessor's output (an #if may leave a line out)
    const pre = `${dir}/${app}.i`;
    run("clang", [...TARGET, "-DNDEBUG", ...floatFlags, "-I.", "-I./lib/", ...CLANG_EXTRA, ...sysC, "-x", "c++", ...sysCxx,
      "-E", "-P", "-w", src, "-o", pre], "preprocessor");
    const preText = fs.text(pre);
    const moduleName = engineNames(preText) || name;
    const sources = [src, ...srcFiles];
    const aliases = engineAliases(preText);
    if (aliases) {
      fs.write(`${dir}/aliases.c`, aliases);
      sources.push(`${dir}/aliases.c`);
    }

    // mkmodule's clang_compile(): source -> IR -> fixed IR -> object
    const externData = new Set();
    const compile = (source_, obj, what) => {
      const f = flags(isCxx(source_)), ll = obj + ".ll";
      run("clang", [...f, "-S", "-emit-llvm", source_, "-o", ll], what);
      let fixed;
      try {
        fixed = fixIR(fs.text(ll));
      } catch (e) {
        if (e instanceof IrError) fail(`${basename(source_)}: ${e.message}`);
        throw e;
      }
      for (const e of fixed.extern) externData.add(e);
      fs.write(ll, fixed.text);
      run("clang", [...TARGET, "-O3", "-Xclang", "-disable-llvm-passes", "-fropi", "-frwpi", "-ffunction-sections",
        "-fdata-sections", "-fomit-frame-pointer", "-fno-unwind-tables", "-fno-asynchronous-unwind-tables",
        "-Wno-override-module", ...f.filter((x) => x.startsWith("-mf") || x.startsWith("-ffast") || x.startsWith("-mllvm")),
        ...CODEGEN_EXTRA, "-c", "-x", "ir", ll, "-o", obj], "code generation");
      tc.fs.unlink(ll);
    };
    const assemble = (s) => {
      const obj = stem(s) + ".o";
      run("clang", ["--target=thumbv7em-none-eabihf", "-x", "assembler-with-cpp", "-mcpu=cortex-m7", "-mthumb", s, "-c", "-o", obj],
        "assembler");
      return obj;
    };

    // mkmodule's compile() for every source: its object, for C++ the object of __init_array(), then for each of
    // them the public functions renamed and a prologue object under their names
    const publicSet = new Set([...PUBLIC_SYMBOLS, "__init_array"]);
    const objects = [];
    let init = false;
    sources.forEach((s, i) => {
      // every object in the app's directory, also that of a source of lib/ (mkmodule writes it beside its source;
      // the tree is not the build's to write into, and two apps may share a source)
      const mine = [s.startsWith(dir + "/") ? stem(s) + ".o" : `${dir}/src${i}_${basename(stem(s))}.o`];
      compile(s, mine[0], s == src ? "app" : basename(s));
      if (isCxx(s) && !init) { // once (mkmodule: for every C++ source, which two of them would not link)
        init = true;
        fs.write(`${dir}/cpp_init_fini.c`, CPP_INIT_FINI);
        mine.push(`${dir}/cpp_init_fini.o`);
        compile(`${dir}/cpp_init_fini.c`, mine[1], "cpp_init_fini.c");
      }
      for (const obj of [...mine]) {
        const bytes = fs.read(obj);
        const renames = {};
        for (const n of publicFunctions(bytes)) if (publicSet.has(n)) renames[n] = wrappedName(n);
        fs.write(obj, redefineSyms(bytes, renames));
        const p = obj + "_prologue.s";
        // lld does not relocate a section without SHF_ALLOC; Tag_ABI_PCS_R9_use: SB, as the RWPI objects
        fs.write(p, prologueAsm(renames).replaceAll('.text_nogc, "x"', '.text_nogc, "ax", %progbits')
          .replace("    .thumb\n", "    .thumb\n    .eabi_attribute 14, 1\n"));
        mine.push(assemble(p));
      }
      objects.push(...mine);
    });

    // mkmodule's link(): the locals of every object get names of their own (uniquify_local_symbols(): the image's
    // symbols are kept by name), the stubs, the linker
    objects.forEach((obj, idx) => {
      const bytes = fs.read(obj), m = uniquifyMap(bytes, idx);
      if (m.size) fs.write(obj, redefineSyms(bytes, m));
    });
    const stubs = stubsAsm(objects.map((o) => fs.read(o)), externData);
    const missing = [...stubs.names, ...externData].filter((n) => !WHITELIST.has(n)).sort();
    if (missing.length) fail(unresolved(missing));
    const inputs = [...objects];
    if (stubs.asm) {
      fs.write(dirname(objects[0]) + "/__stubs.s", stubs.asm);
      inputs.push(assemble(dirname(objects[0]) + "/__stubs.s"));
    }
    const ld = `${dir}/module.ld`, elf = `${dir}/${app}.elf`;
    fs.write(ld, LINKER_SCRIPT);
    run("ld.lld", ["--gc-sections", "-T", ld, "--unresolved-symbols=ignore-all", "--emit-relocs", "-e", "0", ...inputs, "-o", elf],
      "linker");

    const bin = mkmodule(fs.read(elf), { name: moduleName, publicSymbols: PUBLIC_SYMBOLS, clang: true });
    return { ok: true, bin, engines: moduleName.split(";"), warnings };
  } catch (e) {
    if (e instanceof BuildError || e instanceof MkmoduleError) return { ok: false, error: e.message };
    return { ok: false, error: "internal error of the build: " + (e?.stack ?? e) };
  } finally {
    for (const p of written) {
      try { tc.fs.unlink(p); } catch (_) { /* never written, or gone already */ }
    }
  }
}

export const _test = { diagnostics, magic, normalize };
