/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const INSTRUCTIONS = [
  'adc', 'add', 'and', 'bit', 'call', 'ccf', 'cp', 'cpl',
  'daa', 'dec', 'di', 'ei', 'halt', 'inc', 'jp', 'jr',
  'ld', 'ldh', 'ldi', 'ldd', 'nop', 'or', 'pop', 'push',
  'res', 'ret', 'reti', 'rl', 'rla', 'rlc', 'rlca',
  'rr', 'rra', 'rrc', 'rrca', 'rst', 'sbc', 'scf',
  'set', 'sla', 'sra', 'srl', 'stop', 'sub', 'swap', 'xor',
];

// sp handled separately for sp+offset disambiguation
const REGISTERS = ['a', 'b', 'c', 'd', 'e', 'h', 'l', 'af', 'bc', 'de', 'hl'];
const CONDITIONS = ['z', 'nz', 'c', 'nc'];

module.exports = grammar({
  name: 'rgbds',

  extras: $ => [/[ \t\r]/, $.block_comment, $.line_continuation],

  word: $ => $.identifier,

  rules: {
    source_file: $ => seq(repeat($.line), optional($.final_line)),

    // ─── Line structure ───────────────────────────────────────

    _nonempty_line_content: $ => choice(
      seq($.label_definition, optional($.statement), repeat(seq('::', $.statement)), optional($.comment)),
      seq($.statement, repeat(seq('::', $.statement)), optional($.comment)),
      $.comment,
    ),

    line: $ => choice(
      seq($._nonempty_line_content, '\n'),
      '\n',
    ),

    final_line: $ => $._nonempty_line_content,

    statement: $ => choice($.instruction, $.directive, $.macro_invocation),

    line_continuation: _ => token(seq('\\', /[ \t]*\r?\n/)),

    // ─── Comments ─────────────────────────────────────────────

    comment: _ => /;[^\r\n]*/,

    block_comment: _ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),

    // ─── Labels ───────────────────────────────────────────────

    label_definition: $ => choice($.global_label, $.local_label, $.anonymous_label),

    global_label: $ => seq(
      field('name', choice($.identifier, $.scoped_identifier, $.macro_label, $.interpolation)),
      choice('::', ':'),
    ),

    macro_label: _ => /\\([1-9#@]|<[0-9]+>)[a-zA-Z0-9_]*(\{[^}\r\n]*\}[a-zA-Z0-9_]*)*/,

    // Colon-less .name is valid RGBDS, heavily used in real codebases.
    // Precedence ensures colon forms are preferred.
    local_label: $ => choice(
      prec(2, seq(field('name', $.local_identifier), '::')),
      prec(2, seq(field('name', $.local_identifier), ':')),
      field('name', $.local_identifier),
    ),

    anonymous_label: _ => token(prec(-1, ':')),

    // ─── Instructions ─────────────────────────────────────────

    instruction: $ => seq(field('mnemonic', $.mnemonic), optional($.operand_list)),

    mnemonic: _ => token(choice(...INSTRUCTIONS.map(i => ci(i)))),

    operand_list: $ => seq($.operand, repeat(seq(',', $.operand))),

    operand: $ => choice(
      $.sp_offset, $.sp_register, $.negated_condition,
      $.register, $.condition, $.memory_operand, $.expression,
    ),

    sp_offset: $ => prec(2, seq($.sp_register, choice('+', '-'), $.expression)),
    sp_register: _ => token(ci('sp')),
    register: _ => token(choice(...REGISTERS.map(r => ci(r)))),
    condition: _ => token(choice(...CONDITIONS.map(c => ci(c)))),
    negated_condition: $ => seq('!', $.condition),

    // SM83 legal: [hl], [bc], [de], [hl+], [hl-], [c] (high mem), [n16].
    // Uses generic register token — semantic validation deferred to LSP
    // (dedicated tokens cause lexer conflicts with the register token).
    memory_operand: $ => seq('[', choice(
      seq($.register, '+'),
      seq($.register, '-'),
      $.register,
      $.sp_register,
      $.expression,
    ), ']'),

    // ─── Directives ───────────────────────────────────────────

    directive: $ => choice(
      $._core_directive, $._block_directive, $._stack_directive, $._rs_directive,
    ),

    _core_directive: $ => choice(
      $.section_directive, $.load_directive, $.data_directive, $.constant_directive,
      $.include_directive, $.incbin_directive, $.export_directive, $.purge_directive,
      $.charmap_directive, $.newcharmap_directive, $.setcharmap_directive,
      $.assert_directive, $.print_directive, $.warn_directive, $.fail_directive,
      $.opt_directive,
    ),

    _block_directive: $ => choice(
      $.macro_start, $.endm_directive,
      $.if_directive, $.elif_directive, $.else_directive, $.endc_directive,
      $.rept_directive, $.for_directive, $.endr_directive, $.break_directive,
      $.shift_directive, $.endsection_directive,
      $.union_directive, $.nextu_directive, $.endu_directive, $.endl_directive,
    ),

    _stack_directive: $ => choice(
      $.pushs_directive, $.pops_directive,
      $.pusho_directive, $.popo_directive,
      $.pushc_directive, $.popc_directive,
    ),

    _rs_directive: $ => choice(
      $.rsreset_directive, $.rsset_directive, $.rb_directive, $.rw_directive,
    ),

    // ─── Section / Load (shared body) ─────────────────────────

    _section_body: $ => seq(
      optional(choice(ci_kw('UNION'), ci_kw('FRAGMENT'))),
      $.string, ',', $.section_type,
      optional(seq('[', $.expression, ']')),
      repeat(seq(',', $.section_option)),
    ),

    section_directive: $ => seq(ci_kw('SECTION'), $._section_body),
    load_directive: $ => seq(ci_kw('LOAD'), $._section_body),

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

    data_directive: $ => seq(
      field('size', choice(ci_kw('DB'), ci_kw('DW'), ci_kw('DL'), ci_kw('DS'))),
      optional($.expression_list),
    ),

    // ─── Constants ────────────────────────────────────────────

    _def_name: $ => choice($.identifier, $.raw_identifier, $.interpolation, $.macro_label),

    _assignment_op: $ => choice(
      '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=' , ci_kw('SET'),
    ),

    _reserve_op: $ => choice(ci_kw('RB'), ci_kw('RW'), ci_kw('RL')),

    _def_body: $ => choice(
      seq(ci_kw('EQU'), $.expression),
      seq(ci_kw('EQUS'), $.expression),
      seq($._assignment_op, $.expression),
      seq($._reserve_op, optional($.expression)),
    ),

    _redef_body: $ => choice(
      seq(ci_kw('EQU'), $.expression),
      seq(ci_kw('EQUS'), $.expression),
      seq($._assignment_op, $.expression),
    ),

    _legacy_def_body: $ => choice(
      seq(ci_kw('EQU'), $.expression),
      seq(ci_kw('EQUS'), $.expression),
      seq(choice('=', ci_kw('SET')), $.expression),
      seq($._reserve_op, optional($.expression)),
    ),

    constant_directive: $ => choice(
      seq(ci_kw('DEF'), field('name', $._def_name), $._def_body),
      seq(ci_kw('REDEF'), field('name', $._def_name), $._redef_body),
      seq(field('name', $.identifier), $._legacy_def_body),
    ),

    // ─── Include / Incbin ─────────────────────────────────────

    include_directive: $ => seq(ci_kw('INCLUDE'), $.string),

    incbin_directive: $ => seq(
      ci_kw('INCBIN'), $.string,
      optional(seq(',', $.expression, optional(seq(',', $.expression)))),
    ),

    // ─── Export / Purge ───────────────────────────────────────

    _symbol_name: $ => choice($.identifier, $.raw_identifier, $.macro_label, $.macro_arg),
    _symbol_list: $ => seq($._symbol_name, repeat(seq(',', $._symbol_name))),

    export_directive: $ => seq(choice(ci_kw('EXPORT'), ci_kw('GLOBAL')), $._symbol_list),
    purge_directive: $ => seq(ci_kw('PURGE'), $._symbol_list),

    // ─── Macro ────────────────────────────────────────────────

    macro_start: $ => seq(ci_kw_q('MACRO'), field('name', $.identifier)),
    endm_directive: _ => ci_kw('ENDM'),

    // Lowest precedence fallback. Inherently broad but matches RGBDS behavior
    // where any identifier can be a user-defined macro.
    macro_invocation: $ => prec(-2, seq(
      field('name', $.identifier),
      optional($.expression_list),
    )),

    macro_arg: _ => choice(/\\[1-9#@]/, /\\<[0-9]+>/),

    shift_directive: $ => seq(ci_kw('SHIFT'), optional($.expression)),

    // ─── Conditional ──────────────────────────────────────────

    if_directive: $ => seq(ci_kw('IF'), $.expression),
    elif_directive: $ => seq(ci_kw('ELIF'), $.expression),
    else_directive: _ => ci_kw('ELSE'),
    endc_directive: _ => ci_kw('ENDC'),

    // ─── Loops ────────────────────────────────────────────────

    rept_directive: $ => seq(ci_kw_q('REPT'), $.expression),

    for_directive: $ => seq(
      ci_kw_q('FOR'), field('variable', $.identifier), ',',
      $.expression, repeat(seq(',', $.expression)),
    ),

    endr_directive: _ => ci_kw('ENDR'),
    break_directive: _ => ci_kw('BREAK'),
    endl_directive: _ => ci_kw('ENDL'),

    // ─── RS counter ───────────────────────────────────────────
    // Standalone rl cannot be included: 'rl' is both an SM83 mnemonic and an RS
    // directive, and the mnemonic token always wins at the lexer level. The named
    // form 'DEF name RL expr' works via constant_directive's _reserve_op.

    rsreset_directive: _ => ci_kw('RSRESET'),
    rsset_directive: $ => seq(ci_kw('RSSET'), $.expression),
    rb_directive: $ => seq(ci_kw('RB'), optional($.expression)),
    rw_directive: $ => seq(ci_kw('RW'), optional($.expression)),

    // ─── Charmap ──────────────────────────────────────────────

    charmap_directive: $ => seq(ci_kw('CHARMAP'), $.expression, ',', $.expression_list),
    newcharmap_directive: $ => seq(ci_kw('NEWCHARMAP'), $.identifier, optional(seq(',', $.identifier))),
    setcharmap_directive: $ => seq(ci_kw('SETCHARMAP'), $.identifier),
    pushc_directive: $ => seq(ci_kw('PUSHC'), optional($.identifier)),
    popc_directive: _ => ci_kw('POPC'),

    // ─── Assertions / Output ──────────────────────────────────

    // ASSERT [WARN|FAIL|FATAL,] condition [, message]
    assert_directive: $ => seq(
      choice(ci_kw('ASSERT'), ci_kw('STATIC_ASSERT')),
      optional(seq(choice(ci_kw('WARN'), ci_kw('FAIL'), ci_kw('FATAL')), ',')),
      $.expression,
      optional(seq(',', $.expression)),
    ),

    print_directive: $ => seq(choice(ci_kw('PRINT'), ci_kw('PRINTLN')), optional($.expression_list)),

    warn_directive: $ => seq(ci_kw('WARN'), $.expression),
    fail_directive: $ => seq(ci_kw('FAIL'), $.expression),

    // ─── Options / Stacks ─────────────────────────────────────

    opt_directive: $ => seq(ci_kw('OPT'), /[^\r\n;]+/),
    pusho_directive: $ => seq(ci_kw('PUSHO'), optional(/[^\r\n;]+/)),
    popo_directive: $ => seq(ci_kw('POPO'), optional(/[^\r\n;]+/)),
    pushs_directive: _ => ci_kw('PUSHS'),
    pops_directive: _ => ci_kw('POPS'),

    union_directive: _ => ci_kw('UNION'),
    nextu_directive: _ => ci_kw('NEXTU'),
    endu_directive: _ => ci_kw('ENDU'),

    // ─── Expressions ──────────────────────────────────────────

    expression_list: $ => seq($.expression, repeat(seq(',', $.expression)), optional(',')),

    expression: $ => choice(
      $.binary_expression, $.unary_expression, $.parenthesized_expression,
      $.function_call, $.interpolation, $.equs_expansion,
      $.number, $.string, $.char_literal, $.gfx_literal,
      $.symbol_reference, $.macro_arg,
    ),

    // BEST-EFFORT HEURISTIC for EQUS text expansion.
    // EQUS macros expand as raw text before parsing, creating token sequences
    // the grammar cannot predict. The LSP should not rely on the structure of
    // equs_expansion nodes — they are parse-recovery, not semantic.
    _equs_atom: $ => choice($.number, $.identifier, $.macro_arg, $.char_literal, $.parenthesized_expression),

    equs_expansion: $ => prec.left(-1, choice(
      // literal + EQUS identifier: "2 percent", "\2 tiles", "(7*7) tiles"
      seq(choice($.number, $.macro_arg, $.parenthesized_expression, $.macro_label), $.identifier, repeat($._equs_atom)),
      // EQUS identifier + literal: "time_group 10", "tile '0'", "palred 31"
      seq($.identifier, choice($.number, $.char_literal), repeat(choice($.number, $.identifier, $.macro_arg, $.char_literal))),
      // identifier chain: "vTiles2 tile $31" — broadest form, may over-accept
      seq($.identifier, $.identifier, repeat1($._equs_atom)),
    )),

    // Single-level regex. Deeply nested {d:{expr}} requires external scanner.
    interpolation: _ => choice(/\{[^}\r\n]*\}/, /\{\{[^}\r\n]*\}\}/),

    binary_expression: $ => {
      // Left-associative operators (standard)
      /** @type {[string, number][]} */
      const leftOps = [
        ['||', 1],
        ['&&', 2],
        ['===', 3], ['!==', 3], ['==', 3], ['!=', 3], ['<', 3], ['>', 3], ['<=', 3], ['>=', 3],
        ['++', 4], ['+', 4], ['-', 4],
        ['|', 5],
        ['^', 6],
        ['&', 7],
        ['<<', 8], ['>>', 8], ['>>>', 8],
        ['*', 9], ['/', 9], ['%', 9],
      ];
      // Right-associative operators
      /** @type {[string, number][]} */
      const rightOps = [
        ['**', 10],
      ];
      return choice(
        ...leftOps.map(([op, p]) =>
          prec.left(p, seq(field('left', $.expression), op, field('right', $.expression)))
        ),
        ...rightOps.map(([op, p]) =>
          prec.right(p, seq(field('left', $.expression), op, field('right', $.expression)))
        ),
      );
    },

    unary_expression: $ => prec(11, choice(
      seq('-', $.expression), seq('+', $.expression),
      seq('~', $.expression), seq('!', $.expression),
    )),

    parenthesized_expression: $ => seq('(', $.expression, ')'),

    function_call: $ => seq(field('function', $.identifier), '(', optional($.expression_list), ')'),

    _named_ref: $ => choice(
      $.identifier, $.scoped_identifier, $.local_identifier,
      $.macro_label, $.equs_string_ref, $.raw_identifier,
    ),

    symbol_reference: $ => choice($._named_ref, '@', /:[+-]+/),

    // # prefix: EQUS string expansion (#identifier), raw identifier (#keyword),
    // or project-convention hex color (#F8F8A8, #00FF00) — all handled as
    // string-like tokens, never as numbers.
    equs_string_ref: _ => choice(
      /#[a-zA-Z_][a-zA-Z0-9_]*((\{[^}\r\n]*\}|\\[1-9@])[a-zA-Z0-9_]*)*/,
      /#[0-9a-fA-F]+/,       // #hex — treated as string token (e.g. rgb #F8F8A8)
      /#\{[^}\r\n]*\}/,
    ),

    // ─── Tokens ───────────────────────────────────────────────

    // #keyword escapes reserved words as identifiers (RGBDS v1.0.1+)
    raw_identifier: _ => /#[a-zA-Z_][a-zA-Z0-9_]*/,

    identifier: _ => /[a-zA-Z_][a-zA-Z0-9_#@]*((\{[^}\r\n]*\}|\\[1-9@])[a-zA-Z0-9_#@]*)*(\\@)?/,

    // RGBDS spec: "Label names cannot contain more than one period."
    scoped_identifier: _ => /[a-zA-Z_][a-zA-Z0-9_#@]*(\{[^}\r\n]*\}[a-zA-Z0-9_#@]*)*\.[a-zA-Z_][a-zA-Z0-9_#@]*(\{[^}\r\n]*\}[a-zA-Z0-9_#@]*)*(\\@)?/,

    local_identifier: _ => /\.[a-zA-Z_][a-zA-Z0-9_]*((\{[^}\r\n]*\}|\\[1-9@])[a-zA-Z0-9_]*)*(\\@)?/,

    number: _ => choice(
      /\$[0-9a-fA-F_]+/, /0[xX][0-9a-fA-F_]+/,
      /%[01_]+/, /%[.a-zA-Z0-9_]+/, /0[bB][01_]+/,
      /&[0-7_]+/, /0[oO][0-7_]+/,
      /[0-9]+\.[0-9]+[qQ][0-9]+/, /[0-9]+\.[0-9]+/, /[0-9][0-9_]*/,
    ),

    char_literal: _ => choice(/'<[^>\r\n]*>'/, /'\\.[^']*'/, /'[^'\\\r\n]+'/),

    gfx_literal: _ => /`[^\s,;\r\n]+/,

    string: _ => choice(
      // Raw triple-quoted (no escapes, no interpolation)
      token(seq('#"""', /([^"]|"[^"]|""[^"])*/, '"""')),
      // Normal triple-quoted
      token(seq('"""', /([^"]|"[^"]|""[^"])*/, '"""')),
      // Raw single-quoted (no escapes, no interpolation)
      seq('#"', repeat(/[^"\r\n]/), '"'),
      // Normal single-quoted with escapes and interpolation
      seq('"', repeat(choice(/[^"\\\r\n{]/, /\\./, /\{[^}\r\n]*\}/)), '"'),
    ),
  },
});

/** @param {string} kw @returns {RegExp} */
function ci(kw) {
  return new RegExp(kw.split('').map(c =>
    /[a-zA-Z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c
  ).join(''));
}

/** @param {string} kw @returns {RuleOrLiteral} */
function ci_kw(kw) {
  return token(prec(1, ci(kw)));
}

/** keyword with optional ? suffix (MACRO?/REPT?/FOR?) @param {string} kw @returns {RuleOrLiteral} */
function ci_kw_q(kw) {
  return choice(token(prec(1, seq(ci(kw), '?'))), ci_kw(kw));
}
