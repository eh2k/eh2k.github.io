// The compiler of the page: clang and ld.lld for the module's ARM (LLVM built as one WebAssembly file with only
// the ARM backend, machine/src_WASM/cc/build-llvm.sh) on the WASI host and the file tree of js/appbuild/wasi.mjs.
// js/appbuild/buildapp.mjs builds an app with it (what app/build.sh and mkmodule do with gcc), js/appbuild/worker.js
// loads the files and creates it. Nothing here touches the network or the DOM: the same code runs under node
// (machine/src_WASM/cc/test/).
//
// The tree of the compiler, all in memory:
//
//   /app/squares-and-circles-api.h, /app/<GROUP>/<Name>/...    the API and the apps' sources        lib.pack
//   /lib/...                                                   the DSP libraries the apps include  lib.pack
//   /sysroot/include/...                                       newlib and libstdc++ headers (gcc)  sysroot.pack
//   /clang/include/...                                         clang's own headers (stddef.h, ...) sysroot.pack
//   /sysroot/clang-args.json                                   SYSROOT_ARGS for this sysroot       sysroot.pack
//   /tmp                                                       the driver's temporary files
//
// so an app builds from the directory "/" with -I. -I./lib/ as in the checkout. There are no libraries: the apps
// link with -nostdlib.

import { createFs, runWasi, normalize } from "./wasi.mjs";
import { mountPack } from "./packs.mjs";

// The files of wasm/cc/ (gzip'ed, made by machine/src_WASM/cc/pack.py): the compiler first, then the packs in the
// order createToolchain() takes them
export const ASSETS = ["llvm.wasm.gz", "sysroot.pack.gz", "lib.pack.gz"];

// the lines of `clang -###` that are neither a job nor a diagnostic
const BANNER = /^(clang version |Target: |Thread model: |InstalledDir: |Build config: |Configuration file: | \(in-process\))/;
// options of the driver, cc1 and lld that take a path as the next argument (made absolute for a cwd other than "/")
const PATH_ARG = new Set(["-o", "-T", "-I", "-isystem", "-iquote", "-idirafter", "-include", "-resource-dir", "-isysroot", "-L",
  "-internal-isystem", "-internal-externc-isystem", "-MF", "-Map"]);
const PATH_PREFIX = /^(--sysroot=|--redefine-syms=|-fdebug-compilation-dir=|-fcoverage-compilation-dir=|-Map=|-I|-L)(.+)$/;

// the tools of the multicall binary a caller may name (it takes an unknown name for a file and does nothing)
const TOOLS = new Set(["clang", "clang++", "ld.lld", "llvm-nm", "llvm-objcopy", "llvm-strip", "llvm-objdump", "llvm-readelf", "llvm-readobj",
  "llvm-size", "llvm-ar", "llvm-cxxfilt", "llvm-symbolizer", "llvm-addr2line"]);

// a job line of `clang -###`: ' "a" "b c" d' (clang/lib/Driver/Job.cpp Command::Print(): \ " $ escaped in quotes)
function unquote(line) {
  return Array.from(line.matchAll(/ (?:([^ "]+)|"((?:[^"\\$]|\\["\\$])*)")/g),
    (m) => m[1] !== undefined ? m[1] : m[2].replaceAll(/\\["$\\]/g, (x) => x[1]));
}

// wasm: the compiled LLVM driver (a WebAssembly.Module, compiled once, an instance for every run); packs: the
// packs' bytes, gunzipped, in the order of ASSETS without the wasm (more may follow: all are mounted, a later one
// covers an earlier one's files). The packs' bytes stay in use.
export function createToolchain({ wasm, packs = [] }) {
  const fs = createFs();
  const mounted = packs.map((p) => { const m = mountPack(fs, p); return { name: m.name, files: m.files.length, bytes: m.bytes }; });
  const args = fs.readText("/sysroot/clang-args.json");
  const SYSROOT_ARGS = args ? JSON.parse(args) : [];

  // wasi-libc starts in "/" and the one preopened directory is "/": for another directory the paths among the
  // arguments are made absolute here
  const absolute = (argv, cwd) => {
    if (normalize(cwd) === "/") return argv;
    const abs = (p) => normalize(p, cwd);
    return argv.map((a, i) => {
      const m = PATH_PREFIX.exec(a);
      if (m) return m[1] + abs(m[2]);
      if (a.startsWith("-") || a.startsWith("/")) return a;
      if (PATH_ARG.has(argv[i - 1])) return abs(a);
      return fs.exists(abs(a)) ? abs(a) : a; // an input file
    });
  };

  // `clang ...` as the driver would run it: the driver cannot start its jobs in WASI (no processes), so it runs
  // with -### and prints them, and each one (cc1, cc1as) runs as a further instance of the same module
  function clang(argv, cwd) {
    argv = absolute(argv, cwd);
    if (!argv.includes("-resource-dir")) argv = ["-resource-dir", "/clang", ...argv];
    const jobs = [];
    const plan = runWasi(wasm, ["clang", "-###", ...argv], fs);
    jobs.push({ tool: "clang -###", rc: plan.rc, ms: plan.ms, memory: plan.memory });
    const lines = (plan.stderr + plan.stdout).split("\n");
    const notes = lines.filter((l) => l && !l.startsWith(' "') && !BANNER.test(l)).map((l) => l + "\n").join("");
    if (plan.rc) return { rc: plan.rc, stdout: "", stderr: notes, jobs };
    let stdout = "", stderr = notes;
    const temps = []; // the driver's temporary files between its jobs (a preprocessed .s for cc1as): gone afterwards
    const done = (r) => { for (const t of temps) fs.unlink(t); return r; };
    for (const line of lines) {
      if (!line.startsWith(' "')) continue;
      let job = unquote(line);
      if (job[0] === "" && /^-cc1/.test(job[2] || "")) job = job.slice(1); // "" "clang" "-cc1": no install directory
      if (job[1] !== "-cc1" && job[1] !== "-cc1as")
        return done({ rc: 1, stdout, stderr: stderr + "clang: error: this compiler only compiles (-c, -S, -E): it would run " + job[0] + "; link with ld.lld\n", jobs });
      // The output goes to the standard output, which is the file here: the LLVM of the first build reports a
      // stale errno after closing a file it wrote ("IO failure on output stream", Process::SafelyCloseFileDescriptor(),
      // machine/src_WASM/cc/llvm-close-errno.diff), and the standard output is never closed. Harmless with the fix.
      const a = job.slice(1), o = a.lastIndexOf("-o");
      let stdoutFile = null;
      if (o >= 0 && a[o + 1] && a[o + 1] !== "-") { stdoutFile = a[o + 1]; a[o + 1] = "-"; }
      if (stdoutFile && stdoutFile.startsWith("/tmp/") && !argv.includes(stdoutFile)) temps.push(stdoutFile);
      const r = runWasi(wasm, ["", "clang", ...a], fs, { stdoutFile });
      jobs.push({ tool: "clang " + job[1], out: stdoutFile, rc: r.rc, ms: r.ms, memory: r.memory });
      stdout += r.stdout; stderr += r.stderr;
      if (r.rc) { if (stdoutFile) fs.unlink(stdoutFile); return done({ rc: r.rc, stdout, stderr, jobs }); }
    }
    return done({ rc: 0, stdout, stderr, jobs });
  }

  return {
    fs,
    SYSROOT_ARGS,
    packs: mounted,
    // Runs a tool of the LLVM driver to its end: "clang" (also "clang++": the driver, see clang()), "ld.lld", and
    // what else the multicall binary has (TOOLS; llvm-objcopy and llvm-strip cannot write their output there:
    // wasi-libc has no chmod, "Function not implemented"). Relative paths
    // among the arguments are relative to cwd. -> { rc, stdout, stderr, jobs }: rc 0 is success, stderr the
    // diagnostics as the tool prints them (with the paths of this tree), jobs the instances that ran with their
    // time (ms) and memory (bytes). Never throws for what the tool or the source does.
    run(tool, argv, { cwd = "/" } = {}) {
      if (!TOOLS.has(tool)) return { rc: 127, stdout: "", stderr: tool + ": no such tool in the compiler (" + [...TOOLS].join(", ") + ")\n", jobs: [] };
      try {
        if (tool === "clang" || tool === "clang++") {
          const r = clang(tool === "clang++" ? ["--driver-mode=g++", ...argv] : argv, cwd);
          return r;
        }
        const r = runWasi(wasm, [tool, ...absolute(argv, cwd)], fs);
        return { rc: r.rc, stdout: r.stdout, stderr: r.stderr, jobs: [{ tool, rc: r.rc, ms: r.ms, memory: r.memory }] };
      } catch (e) {
        return { rc: -1, stdout: "", stderr: tool + ": " + (e && e.stack || e) + "\n", jobs: [] };
      }
    },
  };
}
