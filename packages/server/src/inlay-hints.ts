import Parser from 'tree-sitter';
import { SM83_INSTRUCTIONS } from './instructions';
import { matchInstructionForm } from './instruction-matcher';
import { SymbolDef } from './types';
import { stripQuotes } from './utils';

export interface AssembledBytesSettings {
    enabled: boolean;
    maxBytesPerLine: number;
}

export const DEFAULT_ASSEMBLED_BYTES_SETTINGS: AssembledBytesSettings = {
    enabled: false,
    maxBytesPerLine: 8,
};

export interface AssembledBytesEntry {
    line: number;
    short: string;
    full: string;
    hasComment: boolean;
}

/**
 * Compute assembled hex bytes for data directives and instructions.
 * Pure static analysis — no ROM needed.
 * Returns per-line byte strings with `hasComment` flag for lines that already have byte annotations.
 */
export function getAssembledBytesData(
    tree: Parser.Tree,
    uri: string,
    rangeStart: number,
    rangeEnd: number,
    settings: AssembledBytesSettings,
    definitions?: Map<string, SymbolDef>,
    getOrParseTree?: (uri: string) => Parser.Tree | undefined,
    encodeString?: (str: string, line: number) => number[] | null,
): AssembledBytesEntry[] {
    if (!settings.enabled) return [];

    const results: AssembledBytesEntry[] = [];
    const sourceLines = tree.rootNode.text.split(/\r?\n/);

    function addEntry(line: number, bytes: number[], lineNode?: Parser.SyntaxNode) {
        if (bytes.length === 0) return;
        const { short, full } = formatBytes(bytes, settings.maxBytesPerLine);

        // Check if this line already has a byte comment
        let hasComment = false;
        if (lineNode && lineNode.startPosition.row === lineNode.endPosition.row) {
            // Single-line: check AST comment node
            const commentNode = lineNode.namedChildren.find(c => c.type === 'comment');
            if (commentNode && parseCommentBytes(commentNode.text)) {
                hasComment = true;
            }
        } else {
            // Multi-line or standalone: check source text
            const srcLine = sourceLines[line];
            if (srcLine) {
                const comment = extractCommentFromSourceLine(srcLine);
                if (comment && parseCommentBytes(comment.text)) {
                    hasComment = true;
                }
            }
        }

        results.push({ line, short, full, hasComment });
    }

    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;
        const lineNum = lineNode.startPosition.row;
        const endRow = lineNode.endPosition.row;

        // Check if this line has a macro invocation
        const macroResult = tryGetMacroHints(lineNode, definitions, getOrParseTree, encodeString);
        if (macroResult) {
            for (const group of macroResult) {
                if (group.line >= rangeStart && group.line <= rangeEnd) {
                    addEntry(group.line, group.bytes, lineNode);
                }
            }
            continue;
        }

        if (lineNum < rangeStart || lineNum > rangeEnd) continue;

        const bytes = getLineBytes(lineNode, definitions, getOrParseTree, encodeString);
        if (bytes && bytes.length > 0) {
            addEntry(lineNum, bytes, lineNode);
        }
    }

    return results;
}

/**
 * Compute the actual byte values a source line produces.
 * Returns null for lines that can't be statically resolved (macros, symbol expressions).
 * Returns empty array for lines that produce no output.
 */
function getLineBytes(
    lineNode: Parser.SyntaxNode,
    definitions?: Map<string, SymbolDef>,
    getTree?: (uri: string) => Parser.Tree | undefined,
    encodeString?: (str: string, line: number) => number[] | null,
): number[] | null {
    for (const child of lineNode.namedChildren) {
        if (child.type === 'statement') {
            return getStatementBytes(child, lineNode.startPosition.row, definitions, getTree, encodeString);
        }
    }
    return null;
}

function getStatementBytes(
    stmtNode: Parser.SyntaxNode,
    line: number,
    definitions?: Map<string, SymbolDef>,
    getTree?: (uri: string) => Parser.Tree | undefined,
    encodeString?: (str: string, line: number) => number[] | null,
): number[] | null {
    for (const child of stmtNode.namedChildren) {
        switch (child.type) {
            case 'instruction':
                return getInstructionBytes(child);
            case 'directive':
                return getDirectiveBytes(child, line, definitions, encodeString);
            case 'macro_invocation':
                return getMacroBytes(child, definitions, getTree, encodeString, line);
        }
    }
    return null;
}

// ─── Instructions ─────────────────────────────────────────────

function getInstructionBytes(instrNode: Parser.SyntaxNode): number[] | null {
    const mnemonicNode = instrNode.children.find(c => c.type === 'mnemonic');
    if (!mnemonicNode) return null;

    const mnemonic = mnemonicNode.text.toLowerCase();
    const forms = SM83_INSTRUCTIONS.filter(i => i.mnemonic === mnemonic);
    if (forms.length === 0) return null;

    const matched = matchInstructionForm(instrNode, forms);
    if (!matched || !matched.opcode) return null;

    const bytes = [...matched.opcode];

    if (matched.bytes > bytes.length) {
        const operandList = instrNode.children.find(c => c.type === 'operand_list');
        const immediateValue = operandList ? extractImmediateValue(operandList) : null;

        if (immediateValue !== null) {
            const remaining = matched.bytes - bytes.length;
            if (remaining === 1) {
                bytes.push(immediateValue & 0xFF);
            } else if (remaining === 2) {
                bytes.push(immediateValue & 0xFF);
                bytes.push((immediateValue >> 8) & 0xFF);
            }
        } else {
            return bytes;
        }
    }

    return bytes;
}

// ─── Macro expansion (mini interpreter) ──────────────────────

interface LineBytes {
    line: number;
    bytes: number[];
}

/**
 * If the line contains a macro invocation, expand it and return per-source-line byte groups.
 * For multi-line invocations (text_box "a", \ "b", \ "c"), each arg line gets its own group.
 */
function tryGetMacroHints(
    lineNode: Parser.SyntaxNode,
    definitions?: Map<string, SymbolDef>,
    getTree?: (uri: string) => Parser.Tree | undefined,
    encodeString?: (str: string, line: number) => number[] | null,
): LineBytes[] | null {
    if (!definitions || !getTree) return null;

    // Find macro_invocation in this line
    let macroNode: Parser.SyntaxNode | null = null;
    for (const c of lineNode.namedChildren) {
        if (c.type !== 'statement') continue;
        for (const sc of c.namedChildren) {
            if (sc.type === 'macro_invocation') { macroNode = sc; break; }
        }
    }
    if (!macroNode) return null;

    const nameNode = macroNode.childForFieldName('name');
    if (!nameNode) return null;

    const macroDef = definitions.get(nameNode.text);
    if (!macroDef || macroDef.type !== 'macro') return null;

    const macroTree = getTree(macroDef.file);
    if (!macroTree) return null;

    // Collect invocation arguments with their source lines
    const args: string[] = [];
    const argLines: number[] = [];
    const exprList = macroNode.children.find(c => c.type === 'expression_list');
    if (exprList) {
        for (const child of exprList.namedChildren) {
            if (child.type === 'expression') {
                args.push(child.text);
                argLines.push(child.startPosition.row);
            }
        }
    }

    // Collect macro body
    const bodyLines = collectMacroBody(macroTree, macroDef.line);
    if (!bodyLines) return null;

    // Execute and get per-argument byte groups
    try {
        const groups = executeMacroBodyGrouped(bodyLines, args, definitions, encodeString, lineNode.startPosition.row);
        if (!groups || groups.length === 0) return null;

        // Map groups to source lines
        const result: LineBytes[] = [];
        const startLine = lineNode.startPosition.row;

        if (groups.length === 1 || argLines.length <= 1) {
            // Single-line invocation: all bytes on one line
            const allBytes = groups.flatMap(g => g);
            result.push({ line: startLine, bytes: allBytes });
        } else {
            // Multi-line: map group[0] to first arg's line, group[1] to second arg's line, etc.
            for (let i = 0; i < groups.length; i++) {
                const line = i < argLines.length ? argLines[i] : argLines[argLines.length - 1];
                result.push({ line, bytes: groups[i] });
            }
        }

        return result;
    } catch {
        return null;
    }
}

function getMacroBytes(
    macroNode: Parser.SyntaxNode,
    definitions?: Map<string, SymbolDef>,
    getTree?: (uri: string) => Parser.Tree | undefined,
    encodeString?: (str: string, line: number) => number[] | null,
    line?: number,
): number[] | null {
    if (!definitions || !getTree) return null;

    const nameNode = macroNode.childForFieldName('name');
    if (!nameNode) return null;

    const macroDef = definitions.get(nameNode.text);
    if (!macroDef || macroDef.type !== 'macro') return null;

    const macroTree = getTree(macroDef.file);
    if (!macroTree) return null;

    // Collect invocation arguments
    const args: string[] = [];
    const exprList = macroNode.children.find(c => c.type === 'expression_list');
    if (exprList) {
        for (const child of exprList.namedChildren) {
            if (child.type === 'expression') args.push(child.text);
        }
    }

    // Collect macro body lines (MACRO line+1 through ENDM-1)
    const bodyLines = collectMacroBody(macroTree, macroDef.line);
    if (!bodyLines) return null;

    // Execute the macro body with a mini interpreter
    try {
        return executeMacroBody(bodyLines, args, definitions, encodeString, line);
    } catch {
        return null; // Bail on any interpretation error
    }
}

function collectMacroBody(tree: Parser.Tree, macroDefLine: number): string[] | null {
    const lines: string[] = [];
    let inBody = false;

    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

        if (lineNode.startPosition.row === macroDefLine) {
            inBody = true;
            continue;
        }

        if (inBody) {
            // Check for ENDM by looking at the raw text
            const text = lineNode.text.trim();
            if (/^ENDM\b/i.test(text)) break;
            lines.push(text);
        }
    }

    return lines.length > 0 ? lines : null;
}

const MAX_ITERATIONS = 100; // Safety limit

interface MacroEmitter {
    emit(bytes: number[]): void;
    onShift(): void;
}

/**
 * Core macro body interpreter. Shared logic for both flat and grouped execution.
 * The emitter interface abstracts how emitted bytes and SHIFT events are handled.
 */
function executeMacroBodyCore(
    bodyLines: string[],
    args: string[],
    definitions: Map<string, SymbolDef>,
    encodeString: ((str: string, line: number) => number[] | null) | undefined,
    sourceLine: number | undefined,
    emitter: MacroEmitter,
): void {
    const vars = new Map<string, number>();
    let iterations = 0;

    function resolveValue(text: string): number | null {
        const trimmed = text.trim();
        const varVal = vars.get(trimmed);
        if (varVal !== undefined) return varVal;
        const num = tryParseNumber(trimmed);
        if (num !== null) return num;
        return resolveConstant(trimmed, definitions);
    }

    function substituteArgs(text: string): string {
        return text
            .replace(/\\#/g, args.join(', '))  // \# = all args joined
            .replace(/\\([1-9])/g, (_, n) => args[parseInt(n) - 1] || '');
    }

    function evalSimpleExpr(expr: string): number | null {
        return evalExpr(expr, args, resolveValue);
    }

    function processLines(lines: string[]): void {
        let i = 0;
        while (i < lines.length) {
            if (++iterations > MAX_ITERATIONS) return;

            let line = substituteArgs(lines[i]);
            const upper = line.replace(/;.*$/, '').trim().toUpperCase();

            // SHIFT
            if (/^SHIFT\b/i.test(upper)) {
                args.shift();
                emitter.onShift();
                i++;
                continue;
            }

            // DEF / REDEF var = expr
            const defMatch = line.match(/^(?:RE)?DEF\s+(\w+)\s*=\s*(.+)$/i);
            if (defMatch) {
                const val = evalSimpleExpr(defMatch[2].replace(/;.*$/, '').trim());
                if (val !== null) vars.set(defMatch[1], val);
                i++;
                continue;
            }

            // REPT expr ... ENDR
            if (/^REPT\b/i.test(upper)) {
                const reptMatch = line.match(/^REPT\s+(.+)$/i);
                const count = reptMatch ? evalSimpleExpr(reptMatch[1].replace(/;.*$/, '').trim()) : 0;
                const reptBody: string[] = [];
                let depth = 1;
                i++;
                while (i < lines.length && depth > 0) {
                    const innerUpper = lines[i].replace(/;.*$/, '').trim().toUpperCase();
                    if (/^REPT\b/.test(innerUpper) || /^FOR\b/.test(innerUpper)) depth++;
                    if (/^ENDR\b/.test(innerUpper)) { depth--; if (depth === 0) break; }
                    reptBody.push(lines[i]);
                    i++;
                }
                i++; // skip ENDR
                if (count !== null && count > 0 && count <= 32) {
                    for (let r = 0; r < count; r++) {
                        processLines(reptBody);
                    }
                }
                continue;
            }

            // IF expr ... ELSE ... ENDC
            if (/^IF\b/i.test(upper)) {
                const ifMatch = line.match(/^IF\s+(.+)$/i);
                const cond = ifMatch ? evalSimpleExpr(ifMatch[1].replace(/;.*$/, '').trim()) : 0;
                const ifBody: string[] = [];
                const elseBody: string[] = [];
                let inElse = false;
                let depth = 1;
                i++;
                while (i < lines.length && depth > 0) {
                    const innerUpper = lines[i].replace(/;.*$/, '').trim().toUpperCase();
                    if (/^IF\b/.test(innerUpper)) depth++;
                    if (/^ENDC\b/.test(innerUpper)) { depth--; if (depth === 0) break; }
                    if (/^ELSE\b/.test(innerUpper) && depth === 1) { inElse = true; i++; continue; }
                    (inElse ? elseBody : ifBody).push(lines[i]);
                    i++;
                }
                i++; // skip ENDC
                processLines(cond ? ifBody : elseBody);
                continue;
            }

            // db/dw directive — emit bytes
            const dbMatch = line.match(/^(db|dw)\s+(.+)$/i);
            if (dbMatch) {
                const kw = dbMatch[1].toLowerCase();
                const valuesText = dbMatch[2].replace(/;.*$/, '').trim();
                const buf: number[] = [];
                emitDataBytes(kw, valuesText, buf, definitions, () => resolveValue, encodeString, sourceLine);
                emitter.emit(buf);
                i++;
                continue;
            }

            i++;
        }
    }

    processLines(bodyLines);
}

/** Evaluate a simple expression supporting +, -, &, |, ^, _NARG. */
function evalExpr(
    expr: string,
    args: string[],
    resolveValue: (text: string) => number | null,
): number | null {
    const s = expr.trim();
    if (s === '_NARG') return args.length;

    // Tokenize: split on operators while keeping them
    // Handle + and - (lowest precedence), then &, |, ^
    // Simple left-to-right evaluation (no precedence beyond this)
    const tokens = s.match(/(?:[^+\-&|^]+|[+\-&|^])/g);
    if (!tokens) return resolveValue(s);

    // Parse into values and operators
    const values: number[] = [];
    const ops: string[] = [];
    let expectValue = true;

    for (const raw of tokens) {
        const tok = raw.trim();
        if (!tok) continue;
        if (expectValue) {
            if (tok === '_NARG') {
                values.push(args.length);
            } else {
                const v = resolveValue(tok);
                if (v === null) return null;
                values.push(v);
            }
            expectValue = false;
        } else {
            ops.push(tok);
            expectValue = true;
        }
    }

    if (values.length === 0) return null;
    if (values.length === 1) return values[0];

    let result = values[0];
    for (let i = 0; i < ops.length; i++) {
        const v = values[i + 1];
        switch (ops[i]) {
            case '+': result = result + v; break;
            case '-': result = result - v; break;
            case '&': result = result & v; break;
            case '|': result = result | v; break;
            case '^': result = result ^ v; break;
            default: return null;
        }
    }
    return result;
}

function executeMacroBody(
    bodyLines: string[],
    args: string[],
    definitions: Map<string, SymbolDef>,
    encodeString?: (str: string, line: number) => number[] | null,
    sourceLine?: number,
): number[] | null {
    const bytes: number[] = [];
    executeMacroBodyCore(bodyLines, args, definitions, encodeString, sourceLine, {
        emit(b) { bytes.push(...b); },
        onShift() { /* no-op for flat output */ },
    });
    return bytes.length > 0 ? bytes : null;
}

/**
 * Like executeMacroBody, but returns byte groups split at each SHIFT.
 * This allows mapping groups to source argument lines for multi-line invocations.
 */
function executeMacroBodyGrouped(
    bodyLines: string[],
    args: string[],
    definitions: Map<string, SymbolDef>,
    encodeString?: (str: string, line: number) => number[] | null,
    sourceLine?: number,
): number[][] | null {
    const groups: number[][] = [[]];
    executeMacroBodyCore(bodyLines, args, definitions, encodeString, sourceLine, {
        emit(b) { groups[groups.length - 1].push(...b); },
        onShift() { groups.push([]); },
    });
    // Filter out empty groups
    const result = groups.filter(g => g.length > 0);
    return result.length > 0 ? result : null;
}

function emitDataBytes(
    keyword: string,
    valuesText: string,
    bytes: number[],
    definitions: Map<string, SymbolDef>,
    getResolver: () => (text: string) => number | null,
    encodeString?: (str: string, line: number) => number[] | null,
    line?: number,
): void {
    const parts = splitDataValues(valuesText);
    const resolve = getResolver();

    for (const part of parts) {
        const trimmed = part.trim();
        // String literal
        if ((trimmed.startsWith('"') || trimmed.startsWith('#"') || trimmed.startsWith('"""')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            const str = stripQuotes(trimmed);
            // Try charmap encoding first
            const encoded = encodeString && line !== undefined ? encodeString(str, line) : null;
            if (encoded) {
                bytes.push(...encoded);
                continue;
            }
            const chars = extractStringChars(trimmed);
            for (const ch of chars) {
                bytes.push(ch);
            }
        } else {
            const val = resolve(trimmed);
            if (val !== null) {
                if (keyword === 'db') bytes.push(val & 0xFF);
                else if (keyword === 'dw') { bytes.push(val & 0xFF, (val >> 8) & 0xFF); }
            } else {
                if (keyword === 'db') bytes.push(-1);
                else if (keyword === 'dw') { bytes.push(-1, -1); }
            }
        }
    }
}

function splitDataValues(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inString = false;
    let quote = '';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            current += ch;
            if (ch === '\\' && i + 1 < text.length) {
                current += text[++i];
            } else if (ch === quote) {
                inString = false;
            }
        } else if (ch === '"' || ch === "'") {
            inString = true;
            quote = ch;
            current += ch;
        } else if (ch === ',') {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) parts.push(current);
    return parts;
}

function extractImmediateValue(operandList: Parser.SyntaxNode): number | null {
    for (const child of [...operandList.children].reverse()) {
        if (child.type === 'operand') {
            const inner = child.children[0];
            if (!inner) continue;
            if (inner.type === 'expression') {
                return tryParseNumber(inner.text);
            }
            if (inner.type === 'memory_operand') {
                for (const mc of inner.children) {
                    if (mc.type === 'expression') {
                        return tryParseNumber(mc.text);
                    }
                }
            }
            if (inner.type === 'number') {
                return tryParseNumber(inner.text);
            }
        }
    }
    return null;
}

// ─── Directives ───────────────────────────────────────────────

function getDirectiveBytes(directiveNode: Parser.SyntaxNode, line: number, definitions?: Map<string, SymbolDef>, encodeString?: (str: string, line: number) => number[] | null): number[] | null {
    const firstChild = directiveNode.firstChild;
    if (!firstChild) return null;

    if (firstChild.type === 'data_directive') {
        return getDataDirectiveBytes(firstChild, line, definitions, encodeString);
    }
    return null;
}

function getDataDirectiveBytes(dataNode: Parser.SyntaxNode, line: number, definitions?: Map<string, SymbolDef>, encodeString?: (str: string, line: number) => number[] | null): number[] | null {
    const keyword = dataNode.text.trim().split(/\s/)[0].toLowerCase();
    if (!['db', 'dw', 'dl', 'ds'].includes(keyword)) return null;

    const exprList = dataNode.children.find(c => c.type === 'expression_list');
    if (!exprList) return null;

    const bytes: number[] = [];

    for (const child of exprList.namedChildren) {
        if (child.type !== 'expression') continue;

        const strNode = findStringInExpression(child);
        if (strNode) {
            const str = stripQuotes(strNode.text);
            // Try charmap encoding first, fall back to ASCII
            const encoded = encodeString ? encodeString(str, line) : null;
            if (encoded) {
                bytes.push(...encoded);
            } else {
                const chars = extractStringChars(strNode.text);
                for (const ch of chars) {
                    if (keyword === 'db') bytes.push(ch);
                    else if (keyword === 'dw') { bytes.push(ch, 0); }
                }
            }
        } else {
            // Try parsing as number literal first
            let val = tryParseNumber(child.text);

            // If not a literal, try resolving as a constant from definitions
            if (val === null && definitions) {
                val = resolveConstant(child.text.trim(), definitions);
            }

            if (val !== null) {
                if (keyword === 'db') bytes.push(val & 0xFF);
                else if (keyword === 'dw') { bytes.push(val & 0xFF, (val >> 8) & 0xFF); }
                else if (keyword === 'dl') { bytes.push(val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF); }
            } else {
                // Unresolvable — insert placeholder
                if (keyword === 'db') bytes.push(-1);
                else if (keyword === 'dw') { bytes.push(-1, -1); }
                else if (keyword === 'dl') { bytes.push(-1, -1, -1, -1); }
            }
        }
    }

    if (keyword === 'ds') {
        const firstExpr = exprList.namedChildren[0];
        if (firstExpr) {
            const count = tryParseNumber(firstExpr.text);
            if (count !== null && count > 0 && count <= 256) {
                const fill = exprList.namedChildren[1]
                    ? (tryParseNumber(exprList.namedChildren[1].text) ?? 0)
                    : 0;
                return Array(count).fill(fill & 0xFF);
            }
        }
        return null;
    }

    if (bytes.length === 0) return null;
    return bytes;
}

/**
 * Resolve a constant symbol name to its numeric value using the indexer definitions.
 */
function resolveConstant(name: string, definitions: Map<string, SymbolDef>): number | null {
    const def = definitions.get(name);
    if (!def || def.type !== 'constant' || !def.value) return null;
    return tryParseNumber(def.value);
}

// ─── String handling ──────────────────────────────────────────

function extractStringChars(quotedStr: string): number[] {
    const inner = stripQuotes(quotedStr);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '\\' && i + 1 < inner.length) {
            i++;
            switch (inner[i]) {
                case 'n': bytes.push(0x0A); break;
                case 'r': bytes.push(0x0D); break;
                case 't': bytes.push(0x09); break;
                case '\\': bytes.push(0x5C); break;
                case '"': bytes.push(0x22); break;
                default: bytes.push(inner.charCodeAt(i)); break;
            }
        } else {
            bytes.push(inner.charCodeAt(i));
        }
    }
    return bytes;
}

function findStringInExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'string') return node;
    for (const child of node.children) {
        const found = findStringInExpression(child);
        if (found) return found;
    }
    return null;
}

// ─── Helpers ──────────────────────────────────────────────────

function tryParseNumber(text: string): number | null {
    const trimmed = text.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^\$[0-9a-fA-F]+$/.test(trimmed)) return parseInt(trimmed.slice(1), 16);
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) return parseInt(trimmed, 16);
    if (/^%[01]+$/.test(trimmed)) return parseInt(trimmed.slice(1), 2);
    return null;
}

function getLineEndCol(lineNode: Parser.SyntaxNode): number {
    const lastChild = lineNode.namedChildren[lineNode.namedChildren.length - 1];
    return lastChild ? lastChild.endPosition.column : lineNode.endPosition.column;
}

export function formatBytesFlat(bytes: number[]): string {
    return bytes.map(b =>
        b === -1 ? '??' : '$' + b.toString(16).toUpperCase().padStart(2, '0')
    ).join(' ');
}

function formatBytes(bytes: number[], maxBytes: number): { short: string; full: string } {
    const allHex = bytes.map(b =>
        b === -1 ? '??' : '$' + b.toString(16).toUpperCase().padStart(2, '0')
    );
    const full = '; ' + allHex.join(' ');

    if (bytes.length <= maxBytes) {
        return { short: full, full };
    }

    const shortHex = allHex.slice(0, maxBytes).join(' ');
    return {
        short: `; ${shortHex} ...`,
        full,
    };
}

// ─── Comment Byte Validation ──────────────────────────────────

export interface ByteMismatchDiagnostic {
    line: number;
    commentCol: number;
    commentEndCol: number;
    commentBytes: number[];
    computedBytes: number[];
}

function parseCommentBytes(commentText: string): number[] | null {
    // Try $XX format first (what formatBytes produces): ; $3E $00
    const prefixedMatch = commentText.match(/^;\s*((?:(?:\$[0-9A-Fa-f]{2}|\?\?)\s*)+)/);
    if (prefixedMatch) {
        const tokens = prefixedMatch[1].trim().split(/\s+/);
        const bytes: number[] = [];
        for (const tok of tokens) {
            if (tok === '??') {
                bytes.push(-1);
            } else if (tok.startsWith('$')) {
                bytes.push(parseInt(tok.slice(1), 16));
            }
        }
        if (bytes.length > 0) return bytes;
    }

    // Try bare hex format: ; 81 23 ff
    // Only match if the ENTIRE comment content (after ;) is hex tokens/wildcards
    const bareMatch = commentText.match(/^;\s*((?:(?:[0-9a-fA-F]{2}|\?\?)\s*)+)$/);
    if (bareMatch) {
        const tokens = bareMatch[1].trim().split(/\s+/);
        const bytes: number[] = [];
        for (const tok of tokens) {
            if (tok === '??') {
                bytes.push(-1);
            } else {
                bytes.push(parseInt(tok, 16));
            }
        }
        if (bytes.length > 0) return bytes;
    }

    return null;
}

function bytesMatch(commentBytes: number[], computedBytes: number[]): boolean {
    if (commentBytes.length !== computedBytes.length) return false;
    for (let i = 0; i < commentBytes.length; i++) {
        if (commentBytes[i] === -1 || computedBytes[i] === -1) continue;
        if (commentBytes[i] !== computedBytes[i]) return false;
    }
    return true;
}

/** Extract comment text from a raw source line (after the last `;` not inside a string). */
function extractCommentFromSourceLine(line: string): { text: string; col: number } | null {
    // Simple scan: find `;` not inside quotes
    let inSingle = false, inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === ';' && !inSingle && !inDouble) {
            return { text: line.slice(i), col: i };
        }
    }
    return null;
}

export function validateCommentBytes(
    tree: Parser.Tree,
    uri: string,
    definitions?: Map<string, SymbolDef>,
    getOrParseTree?: (uri: string) => Parser.Tree | undefined,
    encodeString?: (str: string, line: number) => number[] | null,
    log?: (msg: string) => void,
): ByteMismatchDiagnostic[] {
    const results: ByteMismatchDiagnostic[] = [];
    const filename = uri.split('/').pop();
    const sourceText = tree.rootNode.text;
    const sourceLines = sourceText.split(/\r?\n/);
    log?.(`[ByteValidation] Scanning ${filename}, ${tree.rootNode.children.length} top-level nodes`);

    let commentsFound = 0;
    let bytesCommentsParsed = 0;
    let computedCount = 0;

    function checkLine(
        lineNum: number,
        computedBytes: number[],
        commentText: string,
        commentCol: number,
    ) {
        commentsFound++;
        const commentBytes = parseCommentBytes(commentText);
        if (!commentBytes) return;
        bytesCommentsParsed++;

        log?.(`[ByteValidation] Line ${lineNum + 1}: comment="${commentText.slice(0, 50)}", parsed=[${formatBytesFlat(commentBytes)}]`);

        if (computedBytes.length === 0) return;
        computedCount++;
        if (computedBytes.every(b => b === -1)) return;

        const match = bytesMatch(commentBytes, computedBytes);
        log?.(`[ByteValidation] Line ${lineNum + 1}: computed=[${formatBytesFlat(computedBytes)}], match=${match}`);

        if (!match) {
            results.push({
                line: lineNum,
                commentCol,
                commentEndCol: commentCol + commentText.length,
                commentBytes,
                computedBytes,
            });
        }
    }

    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

        const startRow = lineNode.startPosition.row;
        const endRow = lineNode.endPosition.row;
        const isMultiLine = endRow > startRow;

        // For multi-line nodes (macro with continuations), handle per-visual-line
        if (isMultiLine) {
            const macroResult = tryGetMacroHints(lineNode, definitions, getOrParseTree, encodeString);
            if (!macroResult) continue;

            // Build a map of line → computed bytes from macro groups
            const bytesByLine = new Map<number, number[]>();
            for (const group of macroResult) {
                bytesByLine.set(group.line, group.bytes);
            }

            // Check each visual line in the span for comments
            for (let row = startRow; row <= endRow; row++) {
                const srcLine = sourceLines[row];
                if (!srcLine) continue;

                const comment = extractCommentFromSourceLine(srcLine);
                if (!comment) continue;

                const computed = bytesByLine.get(row);
                if (!computed || computed.length === 0) continue;

                checkLine(row, computed, comment.text, comment.col);
            }
            continue;
        }

        // Single-line node: use AST comment node directly
        const commentNode = lineNode.namedChildren.find(c => c.type === 'comment');
        if (!commentNode) continue;

        let computedBytes: number[] | null = null;
        const macroResult = tryGetMacroHints(lineNode, definitions, getOrParseTree, encodeString);
        if (macroResult) {
            const group = macroResult.find(g => g.line === startRow);
            computedBytes = group?.bytes ?? null;
        } else {
            computedBytes = getLineBytes(lineNode, definitions, getOrParseTree, encodeString);
        }

        if (!computedBytes || computedBytes.length === 0) continue;

        checkLine(startRow, computedBytes, commentNode.text, commentNode.startPosition.column);
    }

    log?.(`[ByteValidation] Done: ${commentsFound} comments, ${bytesCommentsParsed} with byte annotations, ${computedCount} with computed bytes, ${results.length} mismatches`);
    return results;
}
