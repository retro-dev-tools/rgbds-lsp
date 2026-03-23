/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// SM83 (Game Boy CPU) instruction mnemonics
const INSTRUCTIONS = [
  'adc', 'add', 'and', 'bit', 'call', 'ccf', 'cp', 'cpl',
  'daa', 'dec', 'di', 'ei', 'halt', 'inc', 'jp', 'jr',
  'ld', 'ldh', 'ldi', 'ldd', 'nop', 'or', 'pop', 'push',
  'res', 'ret', 'reti', 'rl', 'rla', 'rlc', 'rlca',
  'rr', 'rra', 'rrc', 'rrca', 'rst', 'sbc', 'scf',
  'set', 'sla', 'sra', 'srl', 'stop', 'sub', 'swap', 'xor',
];

// Registers (sp handled separately for sp+offset disambiguation)
const REGISTERS = [
  'a', 'b', 'c', 'd', 'e', 'h', 'l',
  'af', 'bc', 'de', 'hl',
];

// Fix #1: Add 'c' as a condition (z, nz, c, nc)
const CONDITIONS = ['z', 'nz', 'c', 'nc'];

module.exports = grammar({
  name: 'rgbds',

  extras: $ => [
    /[ \t\r]/,
    $.block_comment,
    $.line_continuation,  // Fix #9: backslash line continuation
  ],

  word: $ => $.identifier,

  conflicts: $ => [],

  rules: {
    source_file: $ => seq(
      repeat($.line),
      optional($.final_line),  // Fix #11: file without trailing newline
    ),

    // Fix #4: support multiple statements per line with :: separator
    // Fix #11: final_line handles EOF without newline
    line: $ => seq(
      optional($.label_definition),
      optional($.statement),
      repeat(seq('::', $.statement)),
      optional($.comment),
      '\n',
    ),

    final_line: $ => choice(
      seq($.label_definition, optional($.statement), repeat(seq('::', $.statement)), optional($.comment)),
      seq($.statement, repeat(seq('::', $.statement)), optional($.comment)),
      $.comment,
    ),

    statement: $ => choice(
      $.instruction,
      $.directive,
      $.macro_invocation,
    ),

    // Fix #9: line continuation (allow trailing whitespace before newline)
    line_continuation: _ => token(seq('\\', /[ \t]*\r?\n/)),

    // ─── Comments ─────────────────────────────────────────────

    comment: _ => /;[^\r\n]*/,

    block_comment: _ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),

    // ─── Labels ───────────────────────────────────────────────
    // Fix #5/#6: identifiers can contain dots for scoped labels
    // e.g. AnotherGlobal.with_another_local:

    label_definition: $ => choice(
      $.global_label,
      $.local_label,
      $.anonymous_label,
    ),

    global_label: $ => seq(
      field('name', choice($.identifier, $.scoped_identifier, $.macro_label, $.interpolation)),
      choice('::', ':'),
    ),

    // Labels/identifiers with macro arguments: \1Moves::, \1Special::, TM_\1, \2_tiles
    macro_label: _ => /\\([1-9#@]|<[0-9]+>)[a-zA-Z0-9_]*(\{[^}\r\n]*\}[a-zA-Z0-9_]*)*/,

    // Colon-less form (.name without :) is valid RGBDS syntax and heavily used
    // in real codebases (e.g. pokecrystal has hundreds of instances).
    // Precedence ensures colon forms are preferred when ambiguous.
    local_label: $ => choice(
      prec(2, seq(field('name', $.local_identifier), '::')),
      prec(2, seq(field('name', $.local_identifier), ':')),
      field('name', $.local_identifier),
    ),

    anonymous_label: _ => token(prec(-1, ':')),

    // ─── Instructions ─────────────────────────────────────────

    instruction: $ => seq(
      field('mnemonic', $.mnemonic),
      optional($.operand_list),
    ),

    mnemonic: _ => token(choice(...INSTRUCTIONS.map(i => ci(i)))),

    operand_list: $ => seq(
      $.operand,
      repeat(seq(',', $.operand)),
    ),

    operand: $ => choice(
      $.sp_offset,             // sp+n (must come first)
      $.sp_register,           // standalone sp
      $.negated_condition,     // Fix #2: !cc
      $.register,
      $.condition,
      $.memory_operand,
      $.expression,
    ),

    // Fix #3: sp_offset restricted to literal 'sp' only
    sp_offset: $ => prec(2, seq(
      $.sp_register,
      choice('+', '-'),
      $.expression,
    )),

    // sp is separate from register to allow sp_offset disambiguation
    sp_register: _ => token(ci('sp')),

    register: _ => token(choice(...REGISTERS.map(r => ci(r)))),

    // Fix #1: 'c' included in conditions
    condition: _ => token(choice(...CONDITIONS.map(c => ci(c)))),

    // Fix #2: negated conditions (!z, !nz, !c, !nc)
    negated_condition: $ => seq('!', $.condition),

    // SM83 legal forms: [hl], [bc], [de], [hl+]/[hli], [hl-]/[hld],
    // [c] (ldh high mem), [n16]. The grammar accepts any register here
    // for simplicity — semantic validation (rejecting e.g. [af]) is done
    // by the LSP diagnostics, not the parser.
    memory_operand: $ => seq(
      '[',
      choice(
        seq($.register, '+'),     // [hl+]
        seq($.register, '-'),     // [hl-]
        $.register,               // [hl], [bc], [de], [c]
        $.sp_register,            // [sp]
        $.expression,             // [$addr], [wMyVar]
      ),
      ']',
    ),

    // ─── Directives (flat — block boundaries are just markers) ──

    directive: $ => choice(
      $.section_directive,
      $.data_directive,
      $.constant_directive,
      $.include_directive,
      $.incbin_directive,
      $.export_directive,
      $.purge_directive,
      $.charmap_directive,
      $.newcharmap_directive,
      $.setcharmap_directive,
      $.assert_directive,
      $.print_directive,
      $.warn_directive,
      $.fail_directive,
      $.opt_directive,
      // Block boundary markers (flat, no nesting)
      $.macro_start,
      $.endm_directive,
      $.if_directive,
      $.elif_directive,
      $.else_directive,
      $.endc_directive,
      $.rept_directive,
      $.for_directive,
      $.endr_directive,
      $.break_directive,
      $.shift_directive,
      $.endsection_directive,
      // Fix #7: UNION/NEXTU/ENDU as block markers (also SECTION modifier handled below)
      $.union_directive,
      $.nextu_directive,
      $.endu_directive,
      $.pushs_directive,
      $.pops_directive,
      $.pusho_directive,
      $.popo_directive,
      $.pushc_directive,
      $.popc_directive,
      // Fix #8: LOAD / ENDL
      $.load_directive,
      $.endl_directive,
      // RS counter directives
      $.rsreset_directive,
      $.rsset_directive,
      $.rb_directive,
      $.rw_directive,
      $.rl_directive,
    ),

    // ─── Section ──────────────────────────────────────────────
    // Fix #7: SECTION supports UNION and FRAGMENT modifiers

    section_directive: $ => seq(
      ci_kw('SECTION'),
      optional(choice(ci_kw('UNION'), ci_kw('FRAGMENT'))),
      $.string,
      ',',
      $.section_type,
      optional(seq('[', $.expression, ']')),
      repeat(seq(',', $.section_option)),
    ),

    section_type: _ => token(choice(
      ci('ROM0'), ci('ROMX'), ci('VRAM'), ci('SRAM'),
      ci('WRAM0'), ci('WRAMX'), ci('OAM'), ci('HRAM'),
    )),

    section_option: $ => choice(
      seq(ci_kw('BANK'), '[', $.expression, ']'),
      seq(ci_kw('ALIGN'), '[', $.expression, optional(seq(',', $.expression)), ']'),
    ),

    endsection_directive: _ => ci_kw('ENDSECTION'),

    // ─── Data ─────────────────────────────────────────────────

    // db/dw/dl/ds can appear without arguments (RAM variable declarations)
    data_directive: $ => seq(
      field('size', choice(ci_kw('DB'), ci_kw('DW'), ci_kw('DL'), ci_kw('DS'))),
      optional($.expression_list),
    ),

    // ─── Constants ────────────────────────────────────────────

    _def_name: $ => choice($.identifier, $.interpolation, $.macro_label),

    constant_directive: $ => choice(
      seq(ci_kw('DEF'), field('name', $._def_name), ci_kw('EQU'), $.expression),
      seq(ci_kw('DEF'), field('name', $._def_name), ci_kw('EQUS'), $.expression),
      seq(ci_kw('DEF'), field('name', $._def_name), choice('=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=', ci_kw('SET')), $.expression),
      seq(ci_kw('DEF'), field('name', $._def_name), choice(ci_kw('RB'), ci_kw('RW'), ci_kw('RL')), optional($.expression)),
      seq(ci_kw('REDEF'), field('name', $._def_name), ci_kw('EQUS'), $.expression),
      seq(ci_kw('REDEF'), field('name', $._def_name), ci_kw('EQU'), $.expression),
      seq(ci_kw('REDEF'), field('name', $._def_name), choice('=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=', ci_kw('SET')), $.expression),
      // Legacy (no DEF prefix)
      seq(field('name', $.identifier), ci_kw('EQU'), $.expression),
      seq(field('name', $.identifier), ci_kw('EQUS'), $.expression),
      seq(field('name', $.identifier), choice('=', ci_kw('SET')), $.expression),
      seq(field('name', $.identifier), choice(ci_kw('RB'), ci_kw('RW'), ci_kw('RL')), optional($.expression)),
    ),

    // ─── Include / Incbin ─────────────────────────────────────

    include_directive: $ => seq(ci_kw('INCLUDE'), $.string),

    incbin_directive: $ => seq(
      ci_kw('INCBIN'),
      $.string,
      optional(seq(',', $.expression, optional(seq(',', $.expression)))),
    ),

    // ─── Export / Purge ───────────────────────────────────────

    export_directive: $ => seq(
      choice(ci_kw('EXPORT'), ci_kw('GLOBAL')),
      choice($.identifier, $.macro_label, $.macro_arg),
      repeat(seq(',', choice($.identifier, $.macro_label, $.macro_arg))),
    ),

    purge_directive: $ => seq(
      ci_kw('PURGE'),
      choice($.identifier, $.macro_label, $.macro_arg),
      repeat(seq(',', choice($.identifier, $.macro_label, $.macro_arg))),
    ),

    // ─── Macro (flat boundary markers) ────────────────────────

    // MACRO and MACRO? (conditional macro definition)
    macro_start: $ => seq(
      choice(token(prec(1, seq(ci('MACRO'), '?'))), ci_kw('MACRO')),
      field('name', $.identifier),
    ),

    endm_directive: _ => ci_kw('ENDM'),

    // Lowest precedence fallback: any identifier that didn't match a directive
    // or instruction is treated as a macro invocation. This is inherently broad
    // but matches RGBDS behavior where any identifier can be a user-defined macro.
    macro_invocation: $ => prec(-2, seq(
      field('name', $.identifier),
      optional($.expression_list),
    )),

    macro_arg: _ => choice(
      /\\[1-9#@]/,       // \1 through \9, \#, \@
      /\\<[0-9]+>/,      // \<10> and above
    ),

    shift_directive: $ => seq(ci_kw('SHIFT'), optional($.expression)),

    // ─── Conditional (flat boundary markers) ──────────────────

    if_directive: $ => seq(ci_kw('IF'), $.expression),
    elif_directive: $ => seq(ci_kw('ELIF'), $.expression),
    else_directive: _ => ci_kw('ELSE'),
    endc_directive: _ => ci_kw('ENDC'),

    // ─── Loops (flat boundary markers) ────────────────────────

    rept_directive: $ => seq(
      choice(token(prec(1, seq(ci('REPT'), '?'))), ci_kw('REPT')),
      $.expression,
    ),

    // FOR variable, start, stop[, step] OR FOR variable, count
    // FOR? is the conditional form
    for_directive: $ => seq(
      choice(token(prec(1, seq(ci('FOR'), '?'))), ci_kw('FOR')),
      field('variable', $.identifier),
      ',',
      $.expression,
      repeat(seq(',', $.expression)),
    ),

    endr_directive: _ => ci_kw('ENDR'),
    break_directive: _ => ci_kw('BREAK'),

    // ─── LOAD / ENDL (Fix #8) ─────────────────────────────────

    load_directive: $ => seq(
      ci_kw('LOAD'),
      optional(choice(ci_kw('UNION'), ci_kw('FRAGMENT'))),
      $.string,
      ',',
      $.section_type,
      optional(seq('[', $.expression, ']')),
      repeat(seq(',', $.section_option)),
    ),

    endl_directive: _ => ci_kw('ENDL'),

    // ─── RS counter directives ─────────────────────────────────

    rsreset_directive: _ => ci_kw('RSRESET'),
    rsset_directive: $ => seq(ci_kw('RSSET'), $.expression),
    rb_directive: $ => seq(ci_kw('RB'), optional($.expression)),
    rw_directive: $ => seq(ci_kw('RW'), optional($.expression)),
    rl_directive: $ => seq(ci_kw('RL'), optional($.expression)),

    // ─── Charmap ──────────────────────────────────────────────

    charmap_directive: $ => seq(ci_kw('CHARMAP'), $.expression, ',', $.expression_list),

    newcharmap_directive: $ => seq(
      ci_kw('NEWCHARMAP'),
      $.identifier,
      optional(seq(',', $.identifier)),
    ),

    setcharmap_directive: $ => seq(ci_kw('SETCHARMAP'), $.identifier),

    pushc_directive: $ => seq(ci_kw('PUSHC'), optional($.identifier)),
    popc_directive: _ => ci_kw('POPC'),

    // ─── Assertions / Output ──────────────────────────────────

    assert_directive: $ => seq(
      choice(ci_kw('ASSERT'), ci_kw('STATIC_ASSERT')),
      $.expression,
      optional(seq(',', $.expression)),
    ),

    print_directive: $ => seq(
      choice(ci_kw('PRINT'), ci_kw('PRINTLN')),
      optional($.expression_list),
    ),

    warn_directive: $ => seq(ci_kw('WARN'), $.string),
    fail_directive: $ => seq(ci_kw('FAIL'), $.string),

    // ─── Options / Stacks ─────────────────────────────────────

    opt_directive: $ => seq(ci_kw('OPT'), /[^\r\n;]+/),

    pusho_directive: $ => seq(ci_kw('PUSHO'), optional(/[^\r\n;]+/)),
    popo_directive: $ => seq(ci_kw('POPO'), optional(/[^\r\n;]+/)),
    pushs_directive: _ => ci_kw('PUSHS'),
    pops_directive: _ => ci_kw('POPS'),

    // ─── Union (as standalone block markers too) ──────────────

    union_directive: _ => ci_kw('UNION'),
    nextu_directive: _ => ci_kw('NEXTU'),
    endu_directive: _ => ci_kw('ENDU'),

    // ─── Expressions ──────────────────────────────────────────

    // Expression lists allow optional trailing comma
    expression_list: $ => seq(
      $.expression,
      repeat(seq(',', $.expression)),
      optional(','),
    ),

    expression: $ => choice(
      $.binary_expression,
      $.unary_expression,
      $.parenthesized_expression,
      $.function_call,
      $.interpolation,       // {symbol} curly-brace expansion
      $.equs_expansion,      // number/expr followed by EQUS identifier (e.g. 2 percent)
      $.number,
      $.string,
      $.char_literal,
      $.gfx_literal,         // Fix #10: backtick graphics literal
      $.symbol_reference,
      $.macro_arg,
    ),

    // BEST-EFFORT HEURISTIC for EQUS text expansion.
    //
    // RGBDS EQUS macros expand as raw text before parsing, creating token
    // sequences the grammar cannot predict. For example:
    //   DEF percent EQUS "* $ff / 100"   →  "2 percent" becomes "2 * $ff / 100"
    //   DEF tile EQUS "* $10"            →  "vTiles2 tile $31" becomes "vTiles2 * $10 $31"
    //
    // This rule recognizes common unexpanded patterns so the parser doesn't
    // produce ERROR nodes for valid RGBDS code. It is intentionally broad
    // and low-precedence. The LSP should not rely on the structure of
    // equs_expansion nodes — they are parse-recovery, not semantic.
    //
    // Three forms, from most to least specific:
    equs_expansion: $ => prec.left(-1, choice(
      // Form 1: literal + EQUS identifier: "2 percent", "\2 tiles", "(7*7) tiles"
      seq(
        choice($.number, $.macro_arg, $.parenthesized_expression, $.macro_label),
        $.identifier,
        repeat(choice($.number, $.identifier, $.macro_arg, $.char_literal, $.parenthesized_expression)),
      ),
      // Form 2: EQUS identifier + literal: "time_group 10", "tile '0'", "palred 31"
      seq(
        $.identifier,
        choice($.number, $.char_literal),
        repeat(choice($.number, $.identifier, $.macro_arg, $.char_literal)),
      ),
      // Form 3: identifier chain with args: "vTiles2 tile $31", "palred 31 + palgreen 20"
      // This is the broadest form and may over-accept in rare cases.
      seq(
        $.identifier,
        $.identifier,
        repeat1(choice($.number, $.identifier, $.macro_arg, $.char_literal, $.parenthesized_expression)),
      ),
    )),

    // Symbol interpolation: {identifier}, {format:identifier}, {{nested}}
    // Limitation: single-level regex, won't handle deeply nested {d:{expr}}.
    // Would require an external scanner for full support — not worth the
    // complexity given how rare deep nesting is in practice.
    interpolation: _ => choice(
      /\{[^}\r\n]*\}/,            // single brace
      /\{\{[^}\r\n]*\}\}/,        // double brace {{...}}
    ),

    binary_expression: $ => {
      /** @type {[string, number][]} */
      const ops = [
        ['||', 1],
        ['&&', 2],
        ['===', 3], ['!==', 3], ['==', 3], ['!=', 3], ['<', 3], ['>', 3], ['<=', 3], ['>=', 3],
        ['++', 4], ['+', 4], ['-', 4],
        ['|', 5],
        ['^', 6],
        ['&', 7],
        ['<<', 8], ['>>', 8],
        ['*', 9], ['/', 9], ['%', 9],
        ['**', 10],
      ];
      return choice(
        ...ops.map(([op, p]) =>
          prec.left(p, seq(field('left', $.expression), op, field('right', $.expression)))
        ),
      );
    },

    unary_expression: $ => prec(11, choice(
      seq('-', $.expression),
      seq('+', $.expression),
      seq('~', $.expression),
      seq('!', $.expression),
    )),

    parenthesized_expression: $ => seq('(', $.expression, ')'),

    // Function calls: identifier followed by ( args )
    // Builtin functions (HIGH, LOW, BANK, etc.) are just identifiers syntactically
    function_call: $ => seq(
      field('function', $.identifier),
      '(',
      optional($.expression_list),
      ')',
    ),

    symbol_reference: $ => choice(
      $.identifier,
      $.scoped_identifier,   // Fix #6: Global.local as reference
      $.local_identifier,
      $.macro_label,         // \1_Symbol references
      $.equs_string_ref,    // #identifier — EQUS string expansion
      '@',                   // current PC address
      /:[+-]+/,              // anonymous label refs
    ),

    // #identifier expands an EQUS symbol as a string value
    // Can contain {interpolation} and \1-\9 macro args
    equs_string_ref: _ => choice(
      /#[a-zA-Z_][a-zA-Z0-9_]*((\{[^}\r\n]*\}|\\[1-9@])[a-zA-Z0-9_]*)*/,
      /#\{[^}\r\n]*\}/,       // #{interpolation}
    ),

    // ─── Tokens ───────────────────────────────────────────────

    // RGBDS identifiers: start with [a-zA-Z_], contain # @ in body,
    // can have \@ suffix and {expression} interpolation anywhere
    // Note: $ is NOT valid — it's the hex prefix
    // Note: @ alone is the PC address symbol, not an identifier
    // Identifiers may contain \1-\9 macro args and {expr} interpolation inline
    identifier: _ => /[a-zA-Z_][a-zA-Z0-9_#@]*((\{[^}\r\n]*\}|\\[1-9@])[a-zA-Z0-9_#@]*)*(\\@)?/,

    // Scoped identifier with exactly one dot (Global.local).
    // RGBDS spec: "Label names cannot contain more than one period."
    scoped_identifier: _ => /[a-zA-Z_][a-zA-Z0-9_#@]*(\{[^}\r\n]*\}[a-zA-Z0-9_#@]*)*\.[a-zA-Z_][a-zA-Z0-9_#@]*(\{[^}\r\n]*\}[a-zA-Z0-9_#@]*)*(\\@)?/,

    // Local labels can also have \@ suffix, {expr} interpolation, and \1-\9 args
    local_identifier: _ => /\.[a-zA-Z_][a-zA-Z0-9_]*((\{[^}\r\n]*\}|\\[1-9@])[a-zA-Z0-9_]*)*(\\@)?/,

    // Fix #10: number literals including fixed-point
    // RGBDS allows _ as visual separator in numeric literals
    number: _ => choice(
      /\$[0-9a-fA-F_]+/,           // hex: $FF, $FF_00
      /0[xX][0-9a-fA-F_]+/,        // hex: 0xFF
      /#[0-9a-fA-F_]+/,            // hex color: #F8F8A8
      /%[01_]+/,                    // binary: %1010, %00_11_0000
      /%[.a-zA-Z0-9_]+/,           // EQUS-expanded binary: %..XXXX.. (custom chars via opt)
      /0[bB][01_]+/,               // binary: 0b1010
      /&[0-7_]+/,                   // octal: &77
      /0[oO][0-7_]+/,              // octal: 0o77
      /[0-9]+\.[0-9]+[qQ][0-9]+/,  // fixed-point with precision: 12.34q8
      /[0-9]+\.[0-9]+/,            // fixed-point: 12.34
      /[0-9][0-9_]*/,              // decimal: 100, 1_000
    ),

    // Char literals: 'x', '<CHARMAP_NAME>', '\r', '\n', '\'s', unicode chars
    char_literal: _ => choice(
      /'<[^>\r\n]*>'/,         // charmap: '<BOLD_V>', '<MOBILE>' (must come first)
      /'\\.[^']*'/,            // escape sequences: '\r', '\n', '\'s'
      /'[^'\\\r\n]+'/,         // simple and unicode: 'A', '■', '☎'
    ),

    // Fix #10: backtick graphics literal
    // Characters are configurable via `opt g`, default 0123 but can be any 4 chars
    gfx_literal: _ => /`[^\s,;\r\n]+/,

    // Strings: double-quoted and triple-quoted
    string: _ => choice(
      // Triple-quoted strings (can span lines, contain quotes)
      token(seq('"""', /([^"]|"[^"]|""[^"])*/, '"""')),
      // Double-quoted strings with escapes and interpolation
      seq('"', repeat(choice(/[^"\\\r\n{]/, /\\./, /\{[^}\r\n]*\}/)), '"'),
    ),
  },
});

/**
 * Case-insensitive regex for a keyword.
 * @param {string} keyword
 * @returns {RegExp}
 */
function ci(keyword) {
  return new RegExp(
    keyword.split('').map(c =>
      /[a-zA-Z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c
    ).join('')
  );
}

/**
 * Case-insensitive keyword token (higher precedence to beat identifier).
 * @param {string} keyword
 * @returns {RuleOrLiteral}
 */
function ci_kw(keyword) {
  return token(prec(1, ci(keyword)));
}
