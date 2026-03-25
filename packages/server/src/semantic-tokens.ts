import {
    SemanticTokensBuilder,
    SemanticTokensLegend,
} from 'vscode-languageserver/node';
import Parser from 'tree-sitter';
import { Indexer } from './indexer';

// Standard semantic token types — no custom types
const TOKEN_TYPES = [
    'keyword',     // 0: mnemonics, directive keywords
    'variable',    // 1: registers, constants
    'function',    // 2: labels, macros
    'number',      // 3: numeric literals
    'string',      // 4: string literals
    'comment',     // 5: comments
    'enumMember',  // 6: conditions (z, nz, c, nc)
    'parameter',   // 7: macro args (\1, \2, \@)
];

const TOKEN_MODIFIERS = [
    'declaration', // 0
    'readonly',    // 1
];

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
    tokenTypes: TOKEN_TYPES,
    tokenModifiers: TOKEN_MODIFIERS,
};

const TYPE_KEYWORD = 0;
const TYPE_VARIABLE = 1;
const TYPE_FUNCTION = 2;
const TYPE_NUMBER = 3;
const TYPE_STRING = 4;
const TYPE_COMMENT = 5;
const TYPE_ENUM_MEMBER = 6;
const TYPE_PARAMETER = 7;

const MOD_DECLARATION = 1 << 0;
const MOD_READONLY = 1 << 1;

// Directive node types that should be highlighted as keywords
const DIRECTIVE_TYPES = new Set([
    'section_directive', 'load_directive', 'endsection_directive',
    'data_directive', 'constant_directive',
    'include_directive', 'incbin_directive',
    'export_directive', 'purge_directive',
    'macro_start', 'endm_directive', 'shift_directive',
    'if_directive', 'elif_directive', 'else_directive', 'endc_directive',
    'rept_directive', 'for_directive', 'endr_directive', 'break_directive',
    'endl_directive',
    'union_directive', 'nextu_directive', 'endu_directive',
    'charmap_directive', 'newcharmap_directive', 'setcharmap_directive',
    'pushc_directive', 'popc_directive',
    'pushs_directive', 'pops_directive',
    'pusho_directive', 'popo_directive',
    'opt_directive',
    'assert_directive', 'print_directive', 'warn_directive', 'fail_directive',
    'rsreset_directive', 'rsset_directive',
    'rb_directive', 'rw_directive',
]);

export function computeSemanticTokens(
    tree: Parser.Tree,
    uri: string,
    indexer: Indexer,
    range?: { start: { line: number }; end: { line: number } },
): SemanticTokensBuilder {
    const builder = new SemanticTokensBuilder();
    let currentGlobal = '';

    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

        // Always track global label state for correct local label scoping
        for (const child of lineNode.namedChildren) {
            if (child.type === 'label_definition') {
                const labelNode = child.firstChild;
                if (labelNode?.type === 'global_label') {
                    const nameNode = labelNode.childForFieldName('name');
                    if (nameNode) currentGlobal = nameNode.text;
                }
            }
        }

        // Skip lines outside the requested range (but still tracked global above)
        if (range) {
            const lineRow = lineNode.startPosition.row;
            if (lineRow > range.end.line || lineNode.endPosition.row < range.start.line) continue;
        }

        walkNode(lineNode, builder, indexer, uri, { currentGlobal });
    }

    return builder;
}

interface WalkState {
    currentGlobal: string;
}

function walkNode(
    node: Parser.SyntaxNode,
    builder: SemanticTokensBuilder,
    indexer: Indexer,
    uri: string,
    state: WalkState,
): void {
    // Classify this node
    const token = classifyNode(node, indexer, state);
    if (token) {
        const { line, col, length, type, modifiers } = token;
        builder.push(line, col, length, type, modifiers);
        // Don't recurse into classified leaf nodes
        if (isLeafToken(node.type)) return;
    }

    // Recurse into children
    for (const child of node.namedChildren) {
        walkNode(child, builder, indexer, uri, state);
    }
}

function isLeafToken(type: string): boolean {
    return type === 'mnemonic' || type === 'register' || type === 'sp_register' ||
           type === 'condition' || type === 'number' || type === 'string' ||
           type === 'comment' || type === 'identifier' || type === 'local_identifier' ||
           type === 'macro_arg';
}

interface TokenInfo {
    line: number;
    col: number;
    length: number;
    type: number;
    modifiers: number;
}

function classifyNode(
    node: Parser.SyntaxNode,
    indexer: Indexer,
    state: WalkState,
): TokenInfo | null {
    const pos = node.startPosition;
    const len = node.endPosition.column - node.startPosition.column;
    if (len <= 0 || node.startPosition.row !== node.endPosition.row) return null;

    switch (node.type) {
        case 'mnemonic':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_KEYWORD, modifiers: 0 };

        case 'register':
        case 'sp_register':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_VARIABLE, modifiers: MOD_READONLY };

        case 'condition':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_ENUM_MEMBER, modifiers: 0 };

        case 'number':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_NUMBER, modifiers: 0 };

        case 'string':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_STRING, modifiers: 0 };

        case 'comment':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_COMMENT, modifiers: 0 };

        case 'macro_arg':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_PARAMETER, modifiers: 0 };

        case 'identifier': {
            // Look up in indexer to determine symbol type
            const name = node.text;
            const def = indexer.definitions.get(name);
            if (!def) return null; // Unresolved — fall back to TextMate

            if (def.type === 'constant' || def.type === 'charmap') {
                const isDef = isDefinitionSite(node);
                return {
                    line: pos.row, col: pos.column, length: len,
                    type: TYPE_VARIABLE,
                    modifiers: MOD_READONLY | (isDef ? MOD_DECLARATION : 0),
                };
            }
            if (def.type === 'macro' || def.type === 'label') {
                const isDef = isDefinitionSite(node);
                return {
                    line: pos.row, col: pos.column, length: len,
                    type: TYPE_FUNCTION,
                    modifiers: isDef ? MOD_DECLARATION : 0,
                };
            }
            return null;
        }

        case 'local_identifier':
            return { line: pos.row, col: pos.column, length: len, type: TYPE_FUNCTION, modifiers: 0 };

        default:
            // Check if this is a directive node — highlight the keyword portion
            if (DIRECTIVE_TYPES.has(node.type)) {
                // The keyword is the first few characters of the directive text
                const text = node.text;
                const kwMatch = text.match(/^[a-zA-Z_]+/);
                if (kwMatch) {
                    return {
                        line: pos.row, col: pos.column,
                        length: kwMatch[0].length,
                        type: TYPE_KEYWORD, modifiers: 0,
                    };
                }
            }
            return null;
    }
}

function isDefinitionSite(node: Parser.SyntaxNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    // label_definition > global_label > identifier
    if (parent.type === 'global_label' && parent.parent?.type === 'label_definition') return true;
    // constant_directive has field 'name'
    if (parent.type === 'constant_directive' && parent.childForFieldName('name') === node) return true;
    // macro_start has field 'name'
    if (parent.type === 'macro_start' && parent.childForFieldName('name') === node) return true;
    return false;
}
