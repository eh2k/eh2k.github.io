// The fix-up of clang's LLVM IR between its two runs of an app build (buildapp.mjs compile(): source -> text IR,
// this, text IR -> object), a port of clang_fix_ir() of the mkmodule extension for clang. clang's -fropi -frwpi has
// code and constants PC-relative and writable data relative to the static base r9; two things it cannot express
// are rewritten in the IR, where they are still a line each:
//  - a constant that holds addresses (a vtable, a table of strings) would be read-only data next to the code with
//    R_ARM_ABS32 nobody can apply (the code runs in place, in flash): it becomes a plain global, so it lands in
//    .data, where the loader relocates it;
//  - the firmware's data (extern uint32_t *__t of squares-and-circles-api.h) is not at r9: every function that names
//    such a symbol gets a load of its address from a slot @__imp_<name> in .data at its entry (R_ARM_ABS32 against
//    the undefined symbol, which the loader resolves), and uses that value.
// Text in, text out; the lines stay as they are but for these changes.

// the symbols the linker script defines (code_before_data_clang.ld): weak externals of cpp_init_fini.c, no slots
export const LINKER_SYMS = new Set(["__preinit_array_start", "__preinit_array_end", "__init_array_start", "__init_array_end"]);

const IDENT = "[-a-zA-Z$._][-a-zA-Z$._0-9]*";
const EXTERNAL = new RegExp('^@(' + IDENT + '|"[^"]+") = (external|extern_weak) .*\\b(global|constant) ');
const IS_EXTERNAL = / = (external|extern_weak) /;
const STRING = /c"(\\.|[^"\\])*"/g;
const LABEL = new RegExp('^(' + IDENT + '|\\d+|"[^"]+"):');

export class IrError extends Error {}

/** fixIR(text) -> { text, extern: [names of the firmware's data symbols], constants: number made writable }.
 *  Throws IrError for IR it cannot rewrite. */
export function fixIR(ll) {
  const lines = ll.split("\n");
  const ext = [];
  for (const l of lines) {
    const m = EXTERNAL.exec(l);
    if (m && !LINKER_SYMS.has(m[1])) {
      if (m[1].startsWith('"'))
        throw new IrError(`the external variable ${m[1]} has a name that needs quotes in LLVM IR: not supported`);
      ext.push(m[1]);
    }
  }
  const pats = ext.map((e) => new RegExp("@" + e.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "(?![-a-zA-Z$._0-9])", "g"));
  const out = [];
  let constants = 0;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (l.startsWith("@") && l.includes(" constant ") && !IS_EXTERNAL.test(l)) {
      const init = l.slice(l.indexOf(" = ") + 3).replace(STRING, "");
      if (init.includes("@")) {
        l = l.replace(" constant ", " global ");
        constants++;
      }
      out.push(l);
    } else if (l.startsWith("define ")) {
      let j = i;
      while (j < lines.length && lines[j] != "}") j++;
      if (j == lines.length) throw new IrError("LLVM IR: a function without its closing brace");
      let body = lines.slice(i + 1, j);
      const loads = [];
      ext.forEach((e, k) => {
        const pat = pats[k], to = '%"__imp.' + e + '"';
        let found = false;
        for (const b of body) {
          pat.lastIndex = 0;
          if (pat.test(b)) { found = true; break; }
        }
        if (found) {
          body = body.map((b) => b.replace(pat, () => to));
          loads.push(`  %"__imp.${e}" = load ptr, ptr @"__imp_${e}", align 4`);
        }
      });
      const at = body.length && LABEL.test(body[0]) ? 1 : 0;
      out.push(l);
      for (const b of body.slice(0, at)) out.push(b);
      for (const b of loads) out.push(b);
      for (const b of body.slice(at)) out.push(b);
      out.push("}");
      i = j;
    } else out.push(l);
  }
  for (const e of ext) out.push(`@"__imp_${e}" = weak dso_local global ptr @${e}, align 4`);
  return { text: out.join("\n"), extern: ext, constants };
}
