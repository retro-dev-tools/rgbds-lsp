import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    InitializeResult,
    Location,
    Range,
    DocumentSymbol,
    SymbolKind,
    SymbolInformation,
    DocumentSymbolParams,
    Hover,
    HoverParams,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    Diagnostic,
    DiagnosticSeverity,
    DocumentLink,
    DocumentLinkParams,
    FoldingRange,
    FoldingRangeParams,
    SemanticTokensParams,
    SemanticTokens,
    SemanticTokensRequest,
    CodeAction,
    CodeActionParams,
    FileChangeType,
    ResponseError,
    SignatureHelpParams,
    InlayHint,
    InlayHintKind,
    InlayHintParams,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import Parser from 'tree-sitter';
import { rgbdsIndexer } from './indexer';
import { uriToPath, pathToUri, getNodeAtPosition, parseNumberLiteral, stripQuotes } from './utils';
import { getCompletions } from './completions';
import { SM83_INSTRUCTIONS, InstructionForm } from './instructions';
import { DIRECTIVE_DOCS } from './directives';
import { computeSemanticTokens, SEMANTIC_TOKENS_LEGEND } from './semantic-tokens';
import { getFoldingRanges } from './folding';
import { getCodeActions } from './code-actions';
import { matchInstructionForm } from './instruction-matcher';
import { getAssembledBytesData, AssembledBytesSettings, DEFAULT_ASSEMBLED_BYTES_SETTINGS, validateCommentBytes, formatBytesFlat } from './assembled-bytes';
import { getSignatureHelp } from './signature-help';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let pendingWorkspaceFolders: string[] = [];
let assembledBytesSettings: AssembledBytesSettings = { ...DEFAULT_ASSEMBLED_BYTES_SETTINGS };
let validateCommentBytesEnabled = false;
let inlayHintSettings = { constantValues: true, macroParameters: false };

connection.onInitialize((params: InitializeParams) => {
    // Collect workspace folders for background indexing after handshake
    if (params.workspaceFolders) {
        for (const folder of params.workspaceFolders) {
            pendingWorkspaceFolders.push(uriToPath(folder.uri));
        }
    }

    // Capture assembled bytes settings from initialization options
    const initOptions = params.initializationOptions;
    if (initOptions?.assembledBytes) {
        assembledBytesSettings = {
            enabled: initOptions.assembledBytes.enabled ?? false,
            maxBytesPerLine: initOptions.assembledBytes.maxBytesPerLine ?? 8,
        };
    }
    if (initOptions?.validateCommentBytes != null) {
        validateCommentBytesEnabled = initOptions.validateCommentBytes;
    }
    if (initOptions?.inlayHints) {
        inlayHintSettings = {
            constantValues: initOptions.inlayHints.constantValues ?? true,
            macroParameters: initOptions.inlayHints.macroParameters ?? false,
        };
    }

    connection.console.info(`[Server] Assembled bytes: enabled=${assembledBytesSettings.enabled}`);
    connection.console.info(`[Server] validateCommentBytes: ${validateCommentBytesEnabled}`);

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            completionProvider: { resolveProvider: false, triggerCharacters: ['"', '/'] },
            signatureHelpProvider: {
                triggerCharacters: [' ', ','],
            },
            renameProvider: { prepareProvider: true },
            workspaceSymbolProvider: true,
            documentLinkProvider: {},
            foldingRangeProvider: true,
            semanticTokensProvider: {
                legend: SEMANTIC_TOKENS_LEGEND,
                full: true,
                range: true,
            },
            codeActionProvider: true,
            inlayHintProvider: true,
        },
    };

    if (params.capabilities.workspace?.workspaceFolders) {
        result.capabilities.workspace = {
            workspaceFolders: { supported: true },
        };
    }

    return result;
});

connection.onInitialized(() => {
    connection.console.info('[Server] RGBDS Language Server initialized');

    rgbdsIndexer.onLog = (msg) => connection.console.info(`[Indexer] ${msg}`);

    // Index workspace folders in the background after the handshake completes
    const folders = [...pendingWorkspaceFolders];
    pendingWorkspaceFolders = [];
    (async () => {
        for (const folderPath of folders) {
            const result = await rgbdsIndexer.indexProjectAsync(folderPath);
            connection.console.info(`[Indexer] Indexed workspace: ${folderPath} (${rgbdsIndexer.definitions.size} definitions, ${result.indexed} files)`);
        }
        // Refresh diagnostics for all open documents now that indexing is complete
        for (const doc of documents.all()) {
            connection.sendDiagnostics({
                uri: doc.uri,
                diagnostics: computeDiagnostics(doc),
            });
        }

    })().catch(err => connection.console.error(`[Server] Indexing failed: ${err}`));
});

connection.onShutdown(() => {
    connection.console.info('[Server] Shutting down');
});

connection.onExit(() => {
    process.exit(0);
});

// Reindex on file change
documents.onDidChangeContent(change => {
    rgbdsIndexer.indexFile(change.document.uri, change.document.getText());

    // Send diagnostics
    const diagnostics = computeDiagnostics(change.document);
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

documents.onDidClose(event => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});


// Reindex on external file changes (edits outside VS Code, git operations, etc.)
connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
        const uri = change.uri;
        // Skip files already open in the editor — those are handled by onDidChangeContent
        if (documents.get(uri)) continue;

        try {
            const filePath = uriToPath(uri);
            if (change.type === FileChangeType.Deleted) {
                // Deleted — remove from index
                // Remove definitions
                for (const [name, def] of rgbdsIndexer.definitions) {
                    if (def.file === uri) rgbdsIndexer.definitions.delete(name);
                }
                // Remove references
                for (const [name, refs] of rgbdsIndexer.references) {
                    const filtered = refs.filter(r => r.file !== uri);
                    if (filtered.length === 0) rgbdsIndexer.references.delete(name);
                    else rgbdsIndexer.references.set(name, filtered);
                }
                // Remove include records
                for (const [target, refs] of rgbdsIndexer.includers) {
                    const filtered = refs.filter(r => r.from !== uri);
                    if (filtered.length === 0) rgbdsIndexer.includers.delete(target);
                    else rgbdsIndexer.includers.set(target, filtered);
                }
            } else {
                // Created or changed — reindex
                const content = fs.readFileSync(filePath, 'utf-8');
                rgbdsIndexer.indexFile(uri, content);
            }
        } catch {
            // File may not exist or be unreadable
        }
    }

    // Refresh diagnostics for open documents
    for (const doc of documents.all()) {
        connection.sendDiagnostics({
            uri: doc.uri,
            diagnostics: computeDiagnostics(doc),
        });
    }

    // Check if ROM/sym files changed — reload and refresh inlay hints
});

// Handle settings changes at runtime
connection.onDidChangeConfiguration((params) => {
    const settings = params.settings?.rgbds;
    if (settings) {
        assembledBytesSettings = {
            enabled: settings.assembledBytes?.enabled ?? false,
            maxBytesPerLine: settings.assembledBytes?.maxBytesPerLine ?? 8,
        };
        connection.console.log(`[Config] Settings updated`);
        if (settings.inlayHints) {
            inlayHintSettings = {
                constantValues: settings.inlayHints.constantValues ?? true,
                macroParameters: settings.inlayHints.macroParameters ?? false,
            };
        }
    }
});

// ─── Go to Definition ─────────────────────────────────────────

connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const defTree = rgbdsIndexer.getOrParseTree(doc.uri);
    if (defTree) {
        const node = getNodeAtPosition(defTree, params.position.line, params.position.character);

        // Check if cursor is inside a string — go to MTE charmap definition
        let stringWalk: Parser.SyntaxNode | null = node;
        while (stringWalk) {
            if (stringWalk.type === 'string') {
                const mteLocation = getMteDefinitionAtCursor(doc.uri, stringWalk, params.position);
                if (mteLocation) return mteLocation;
                break;
            }
            stringWalk = stringWalk.parent;
        }

        // Check if cursor is on an INCLUDE path string
        let walk: Parser.SyntaxNode | null = node;
        while (walk) {
            if (walk.type === 'include_directive' || walk.type === 'incbin_directive') {
                const stringNode = walk.namedChildren.find(c => c.type === 'string');
                if (stringNode) {
                    const raw = stripQuotes(stringNode.text);
                    const docPath = uriToPath(doc.uri);
                    const resolved = path.resolve(path.dirname(docPath), raw);
                    if (fs.existsSync(resolved)) {
                        return {
                            uri: pathToUri(resolved),
                            range: Range.create(0, 0, 0, 0),
                        };
                    }
                }
                break;
            }
            if (walk.type === 'line' || walk.type === 'final_line') break;
            walk = walk.parent;
        }
    }

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    const def = rgbdsIndexer.definitions.get(symbol);
    if (!def) return null;

    return {
        uri: def.file,
        range: Range.create(def.line, def.col, def.line, def.endCol),
    };
});

// ─── Find References ──────────────────────────────────────────

connection.onReferences((params): Location[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    // Check if cursor is on an INCLUDE path — return all files that include the target
    const refTree = rgbdsIndexer.getTree(doc.uri);
    if (refTree) {
        const node = getNodeAtPosition(refTree, params.position.line, params.position.character);
        let walk: Parser.SyntaxNode | null = node;
        while (walk) {
            if (walk.type === 'include_directive' || walk.type === 'incbin_directive') {
                const stringNode = walk.namedChildren.find(c => c.type === 'string');
                if (stringNode) {
                    const raw = stripQuotes(stringNode.text);
                    const docPath = uriToPath(doc.uri);
                    const resolved = path.resolve(path.dirname(docPath), raw);
                    const targetUri = pathToUri(resolved);
                    const includeRefs = rgbdsIndexer.includers.get(targetUri) || [];
                    return includeRefs.map(r => ({
                        uri: r.from,
                        range: Range.create(r.line, r.col, r.line, r.endCol),
                    }));
                }
                break;
            }
            if (walk.type === 'line' || walk.type === 'final_line') break;
            walk = walk.parent;
        }
    }

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return [];

    const locations: Location[] = [];

    const refs = rgbdsIndexer.references.get(symbol) || [];
    for (const ref of refs) {
        locations.push({
            uri: ref.file,
            range: Range.create(ref.line, ref.col, ref.line, ref.endCol),
        });
    }

    // Include the definition itself
    const def = rgbdsIndexer.definitions.get(symbol);
    if (def) {
        locations.push({
            uri: def.file,
            range: Range.create(def.line, def.col, def.line, def.endCol),
        });
    }

    return locations;
});

// ─── Hover ────────────────────────────────────────────────────

connection.onHover((params: HoverParams): Hover | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    // String hover — show charmap encoding info
    const hoverTree = rgbdsIndexer.getOrParseTree(doc.uri);
    if (hoverTree) {
        const hoverNode = getNodeAtPosition(hoverTree, params.position.line, params.position.character);
        let walk: Parser.SyntaxNode | null = hoverNode;
        while (walk) {
            if (walk.type === 'string') {
                return getStringHover(doc.uri, walk, params.position.line, params.position.character);
            }
            walk = walk.parent;
        }
    }

    // Try symbol hover first
    const symbol = getSymbolAtPosition(doc, params.position);
    if (symbol) {
        const def = rgbdsIndexer.definitions.get(symbol);
        if (def) {
            const refs = rgbdsIndexer.references.get(symbol) || [];

            // Build signature line
            let signature = def.name;
            if (def.type === 'constant' && def.value) {
                signature += ` EQU ${def.value}`;
            }

            let md = `\`\`\`rgbds\n${signature}\n\`\`\`\n`;
            // Info line
            const info: string[] = [`*${def.type}*`];
            if (def.isExported) info.push('exported');
            info.push(`\`${path.basename(uriToPath(def.file))}:${def.line + 1}\``);
            if (refs.length > 0) info.push(`${refs.length} ref${refs.length === 1 ? '' : 's'}`);
            md += info.join(' · ');

            // For numeric constants, show value in other bases
            if (def.type === 'constant' && def.value) {
                const parsed = parseNumberLiteral(def.value);
                if (parsed && !parsed.isFixedPoint) {
                    md += `\n\n\`${parsed.decimal}\` · \`${parsed.hex}\` · \`${parsed.binary}\``;
                }
            }

            if (def.docComment) md += `\n\n---\n\n${def.docComment}`;

            return { contents: { kind: 'markdown', value: md } };
        }
    }

    // Try AST-based hover (numbers, mnemonics, directives)
    const tree = rgbdsIndexer.getTree(doc.uri);
    if (tree) {
        const node = getNodeAtPosition(tree, params.position.line, params.position.character);

        // Number literal hover
        if (node.type === 'number') {
            const parsed = parseNumberLiteral(node.text);
            if (parsed) {
                let md: string;
                if (parsed.isFixedPoint) {
                    md = `\`${node.text}\` = **${parsed.decimal}** *(fixed-point)*`;
                } else {
                    md = `\`\`\`\n`;
                    md += `Dec  ${parsed.decimal}\n`;
                    md += `Hex  ${parsed.hex}\n`;
                    md += `Bin  ${parsed.binary}\n`;
                    md += `Oct  ${parsed.octal}\n`;
                    md += `\`\`\``;
                }
                return { contents: { kind: 'markdown', value: md } };
            }
        }

        // Instruction mnemonic hover
        if (node.type === 'mnemonic') {
            const mnemonic = node.text.toLowerCase();
            const forms = SM83_INSTRUCTIONS.filter(i => i.mnemonic === mnemonic);
            if (forms.length > 0) {
                // Try to match the specific form from the AST
                const instrNode = node.parent;
                const matched = instrNode ? matchInstructionForm(instrNode, forms) : null;
                const primary = matched || forms[0];

                let md = `\`\`\`rgbds\n${primary.label}\n\`\`\`\n`;
                md += `${primary.description}\n\n`;
                md += `${primary.bytes} byte${primary.bytes > 1 ? 's' : ''} · ${primary.cycles} cycles`;
                if (primary.flags !== '-') md += ` · \`${primary.flags}\``;

                return { contents: { kind: 'markdown', value: md } };
            }
        }

        // Directive keyword hover
        const directiveKey = getDirectiveKeyword(node);
        if (directiveKey) {
            const dirDoc = DIRECTIVE_DOCS.get(directiveKey);
            if (dirDoc) {
                let md = `\`\`\`rgbds\n${dirDoc.syntax}\n\`\`\`\n\n`;
                md += dirDoc.description;
                return { contents: { kind: 'markdown', value: md } };
            }
        }
    }

    return null;
});

// ─── Document Symbols ─────────────────────────────────────────

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const symbols: DocumentSymbol[] = [];
    let currentGlobal: DocumentSymbol | null = null;

    const defs = Array.from(rgbdsIndexer.definitions.values())
        .filter(d => d.file === params.textDocument.uri)
        .sort((a, b) => a.line - b.line);

    for (const def of defs) {
        let kind: SymbolKind = SymbolKind.Variable;
        if (def.type === 'label') kind = SymbolKind.Function;
        else if (def.type === 'constant') kind = SymbolKind.Constant;
        else if (def.type === 'macro') kind = SymbolKind.Method;
        else if (def.type === 'section') kind = SymbolKind.Namespace;
        else if (def.type === 'charmap') kind = SymbolKind.Enum;

        const range = Range.create(def.line, def.col, def.line, def.endCol);
        const docSymbol: DocumentSymbol = {
            name: def.name,
            kind,
            range,
            selectionRange: range,
            children: [],
        };

        if (def.isLocal && currentGlobal?.children) {
            currentGlobal.children.push(docSymbol);
        } else {
            if (def.type === 'label' || def.type === 'section') {
                currentGlobal = docSymbol;
            }
            symbols.push(docSymbol);
        }
    }

    return symbols;
});

// ─── Workspace Symbols ───────────────────────────────────────

connection.onWorkspaceSymbol((params): SymbolInformation[] => {
    const query = params.query.toLowerCase();
    const results: SymbolInformation[] = [];

    for (const [name, def] of rgbdsIndexer.definitions) {
        if (query && !name.toLowerCase().includes(query)) continue;

        let kind: SymbolKind = SymbolKind.Variable;
        if (def.type === 'label') kind = SymbolKind.Function;
        else if (def.type === 'constant') kind = SymbolKind.Constant;
        else if (def.type === 'macro') kind = SymbolKind.Method;
        else if (def.type === 'section') kind = SymbolKind.Namespace;
        else if (def.type === 'charmap') kind = SymbolKind.Enum;

        results.push({
            name,
            kind,
            location: {
                uri: def.file,
                range: Range.create(def.line, def.col, def.line, def.endCol),
            },
        });

        if (results.length >= 500) break;
    }

    return results;
});

// ─── Document Links ──────────────────────────────────────────

connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] => {
    const tree = rgbdsIndexer.getOrParseTree(params.textDocument.uri);
    if (!tree) return [];

    const links: DocumentLink[] = [];
    const docPath = uriToPath(params.textDocument.uri);
    const docDir = path.dirname(docPath);

    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

        for (const child of lineNode.children) {
            if (child.type !== 'statement') continue;
            for (const stmt of child.children) {
                if (stmt.type !== 'directive') continue;
                const directive = stmt.firstChild;
                if (!directive) continue;
                if (directive.type !== 'include_directive' && directive.type !== 'incbin_directive') continue;

                const stringNode = directive.children.find(c => c.type === 'string');
                if (!stringNode) continue;

                const raw = stripQuotes(stringNode.text);
                const resolved = path.resolve(docDir, raw);
                if (fs.existsSync(resolved)) {
                    links.push({
                        range: Range.create(
                            stringNode.startPosition.row,
                            stringNode.startPosition.column,
                            stringNode.endPosition.row,
                            stringNode.endPosition.column,
                        ),
                        target: pathToUri(resolved),
                    });
                }
            }
        }
    }

    // Add MTE charmap links for strings
    addMteLinks(params.textDocument.uri, tree, links);

    return links;
});

function addMteLinks(uri: string, tree: Parser.Tree, links: DocumentLink[]): void {
    for (const lineNode of tree.rootNode.children) {
        if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

        findStringsInLine(lineNode, (stringNode) => {
            const str = stripQuotes(stringNode.text);
            if (!str) return;

            const strLine = stringNode.startPosition.row;
            const activeCharmap = rgbdsIndexer.getActiveCharmap(uri, strLine);
            if (!activeCharmap) return;

            const segments = rgbdsIndexer.encodeString(activeCharmap, str);
            if (!segments) return;

            const strStartCol = stringNode.startPosition.column + 1;
            let pos = 0;
            for (const seg of segments) {
                if (seg.isMte) {
                    const entry = rgbdsIndexer.getCharmapEntryDef(activeCharmap, seg.source);
                    if (entry) {
                        const hex = entry.bytes.map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                        links.push({
                            range: Range.create(
                                strLine, strStartCol + pos,
                                strLine, strStartCol + pos + seg.source.length,
                            ),
                            target: `${entry.file}#L${entry.line + 1}`,
                            tooltip: `MTE: "${seg.source}" → ${hex}`,
                        });
                    }
                }
                pos += seg.source.length;
            }
        });
    }
}

function findStringsInLine(node: Parser.SyntaxNode, callback: (strNode: Parser.SyntaxNode) => void): void {
    if (node.type === 'string') {
        callback(node);
        return;
    }
    for (const child of node.children) {
        findStringsInLine(child, callback);
    }
}

// ─── Folding Ranges ──────────────────────────────────────────

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
    const tree = rgbdsIndexer.getTree(params.textDocument.uri);
    if (!tree) return [];
    return getFoldingRanges(tree);
});

// ─── Semantic Tokens ─────────────────────────────────────────

connection.onRequest(SemanticTokensRequest.type, (params: SemanticTokensParams): SemanticTokens => {
    const tree = rgbdsIndexer.getTree(params.textDocument.uri);
    if (!tree) return { data: [] };
    const builder = computeSemanticTokens(tree, params.textDocument.uri, rgbdsIndexer);
    return builder.build();
});

connection.onRequest('textDocument/semanticTokens/range', (params: { textDocument: { uri: string }; range: Range }): SemanticTokens => {
    const tree = rgbdsIndexer.getTree(params.textDocument.uri);
    if (!tree) return { data: [] };
    const builder = computeSemanticTokens(tree, params.textDocument.uri, rgbdsIndexer, params.range);
    return builder.build();
});

// ─── Code Actions ────────────────────────────────────────────

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
    const tree = rgbdsIndexer.getTree(params.textDocument.uri);
    return getCodeActions(params, tree);
});

// ─── Inlay Hints ──────────────────────────────────────────────

function formatConstantValue(value: string): string | null {
    const parsed = parseNumberLiteral(value);
    if (!parsed || parsed.isFixedPoint) return null;
    const num = parsed.value;
    if (num >= 0 && num <= 0xFFFF) {
        return `= $${num.toString(16).toUpperCase().padStart(num > 0xFF ? 4 : 2, '0')}`;
    }
    return `= ${num}`;
}

connection.languages.inlayHint.on((params: InlayHintParams): InlayHint[] => {
    const hints: InlayHint[] = [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return hints;

    const treeOrUndef = rgbdsIndexer.getOrParseTree(doc.uri);
    if (!treeOrUndef) return hints;
    const tree: Parser.Tree = treeOrUndef;

    const startRow = params.range.start.line;
    const endRow = params.range.end.line;

    // Walk the AST nodes in the visible range
    function walkNode(node: Parser.SyntaxNode): void {
        // Skip nodes entirely outside range
        if (node.endPosition.row < startRow || node.startPosition.row > endRow) return;

        if (inlayHintSettings.constantValues && node.type === 'symbol_reference') {
            // Look up the identifier text and check if it resolves to a constant with a numeric value
            const nameNode = node.firstNamedChild;
            if (nameNode) {
                let symbolName = nameNode.text;
                // Scope local identifiers (.name) to their enclosing global label
                if (symbolName.startsWith('.') && nameNode.type === 'local_identifier') {
                    const globalLabel = findEnclosingGlobalLabel(tree, nameNode.startPosition.row);
                    if (globalLabel) symbolName = globalLabel + symbolName;
                }
                const def = rgbdsIndexer.definitions.get(symbolName);
                if (def && def.type === 'constant' && def.value) {
                    const hint = formatConstantValue(def.value);
                    if (hint) {
                        hints.push({
                            position: {
                                line: node.endPosition.row,
                                character: node.endPosition.column,
                            },
                            label: ` ${hint}`,
                            kind: InlayHintKind.Type,
                            paddingLeft: false,
                        });
                    }
                }
            }
            // Don't descend into symbol_reference children to avoid double-hints
            return;
        }

        if (inlayHintSettings.macroParameters && node.type === 'macro_invocation') {
            const nameNode = node.namedChildren.find(c => c.type === 'identifier');
            const exprList = node.namedChildren.find(c => c.type === 'expression_list');
            if (nameNode && exprList) {
                const macroName = nameNode.text;
                const macroDef = rgbdsIndexer.definitions.get(macroName);
                if (macroDef && macroDef.type === 'macro') {
                    // Determine parameter count by scanning the macro body for \1, \2, etc.
                    const macroTree = rgbdsIndexer.getOrParseTree(macroDef.file);
                    let maxParam = 0;
                    if (macroTree) {
                        const macroSource = macroTree.rootNode.text;
                        const macroLines = macroSource.split(/\r?\n/);
                        for (let i = macroDef.line + 1; i < macroLines.length; i++) {
                            const line = macroLines[i];
                            if (/^\s*ENDM\b/i.test(line)) break;
                            const paramRefs = line.match(/\\([1-9])/g);
                            if (paramRefs) {
                                for (const ref of paramRefs) {
                                    const num = parseInt(ref[1]);
                                    if (num > maxParam) maxParam = num;
                                }
                            }
                        }
                    }
                    if (maxParam === 0) maxParam = 1;

                    // Get argument expressions from expression_list.
                    // expression_list children are all named (expression is a choice, each variant
                    // has its own node type — commas are anonymous and excluded from namedChildren).
                    const args = exprList.namedChildren;
                    for (let i = 0; i < args.length && i < maxParam; i++) {
                        const arg = args[i];
                        hints.push({
                            position: {
                                line: arg.startPosition.row,
                                character: arg.startPosition.column,
                            },
                            label: `\\${i + 1}: `,
                            kind: InlayHintKind.Parameter,
                            paddingRight: false,
                        });
                    }
                }
            }
            // Still descend into macro invocation children (e.g., constant refs in args)
        }

        for (const child of node.namedChildren) {
            walkNode(child);
        }
    }

    walkNode(tree.rootNode);

    return hints;
});

// ─── Assembled Bytes ──────────────────────────────────────────

connection.onRequest('rgbds/assembledBytes', (params: { uri: string; startLine: number; endLine: number }) => {
    const tree = rgbdsIndexer.getTree(params.uri);
    if (!tree) return { lines: [] };
    const entries = getAssembledBytesData(
        tree,
        params.uri,
        params.startLine,
        params.endLine,
        assembledBytesSettings,
        rgbdsIndexer.definitions,
        (u) => rgbdsIndexer.getOrParseTree(u),
        (str, line) => {
            const charmap = rgbdsIndexer.getActiveCharmap(params.uri, line);
            return charmap ? rgbdsIndexer.encodeStringBytes(charmap, str) : null;
        },
    );
    return { lines: entries };
});

// ─── Workspace Folder Changes ─────────────────────────────────

try { connection.workspace.onDidChangeWorkspaceFolders(event => {
    // Index newly added folders
    for (const added of event.added) {
        const folderPath = uriToPath(added.uri);
        rgbdsIndexer.indexProjectAsync(folderPath)
            .then(result => {
                connection.console.info(`[Server] Indexed added folder: ${result.indexed} files`);
                // Refresh diagnostics for open documents
                for (const doc of documents.all()) {
                    const diagnostics = computeDiagnostics(doc);
                    connection.sendDiagnostics({ uri: doc.uri, diagnostics });
                }
            })
            .catch(err => connection.console.error(`[Server] Failed to index folder: ${err}`));
    }

    // Remove symbols from removed folders
    for (const removed of event.removed) {
        rgbdsIndexer.removeFolder(uriToPath(removed.uri));
        // Refresh diagnostics
        for (const doc of documents.all()) {
            const diagnostics = computeDiagnostics(doc);
            connection.sendDiagnostics({ uri: doc.uri, diagnostics });
        }
    }
}); } catch { /* client doesn't support workspace folder change notifications */ }

// ─── Completion ───────────────────────────────────────────────

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    const lineText = doc
        ? (doc.getText().split(/\r?\n/)[params.position.line] || '')
        : '';

    return getCompletions(params, rgbdsIndexer, lineText);
});

// ─── Signature Help ───────────────────────────────────────────

connection.onSignatureHelp((params: SignatureHelpParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return getSignatureHelp(doc, params.position, rgbdsIndexer.definitions,
        (uri) => rgbdsIndexer.getOrParseTree(uri));
});

// ─── Rename ───────────────────────────────────────────────────

connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    const def = rgbdsIndexer.definitions.get(symbol);
    if (!def) return null;

    // Return the range of the word under cursor
    const word = getWordRangeAtPosition(doc, params.position);
    return word;
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    // Validate new name
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(params.newName) && !/^\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(params.newName)) {
        throw new ResponseError(-32602, `Invalid RGBDS identifier: "${params.newName}"`);
    }

    const def = rgbdsIndexer.definitions.get(symbol);
    const refs = rgbdsIndexer.references.get(symbol) || [];
    if (!def && refs.length === 0) return null;

    const changes: { [uri: string]: TextEdit[] } = {};

    const addEdit = (fileUri: string, line: number, col: number, endCol: number) => {
        if (!changes[fileUri]) changes[fileUri] = [];
        changes[fileUri].push(TextEdit.replace(
            Range.create(line, col, line, endCol),
            params.newName,
        ));
    };

    if (def) {
        addEdit(def.file, def.line, def.col, def.endCol);
    }
    for (const ref of refs) {
        addEdit(ref.file, ref.line, ref.col, ref.endCol);
    }

    return { changes };
});

// ─── Diagnostics ──────────────────────────────────────────────

function computeDiagnostics(doc: TextDocument): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const uri = doc.uri;

    // Find references to undefined symbols in this file
    const fileRefNames = rgbdsIndexer.fileReferences.get(uri);
    if (fileRefNames) {
        for (const name of fileRefNames) {
            if (rgbdsIndexer.definitions.has(name)) continue;
            const refs = rgbdsIndexer.references.get(name);
            if (!refs) continue;
            for (const ref of refs) {
                if (ref.file !== uri) continue;
                diagnostics.push({
                    range: Range.create(ref.line, ref.col, ref.line, ref.endCol),
                    severity: DiagnosticSeverity.Warning,
                    message: `Undefined symbol: ${name}`,
                    source: 'rgbds',
                });
            }
        }
    }

    // Cross-file duplicate definitions
    const fileDefNames = rgbdsIndexer.fileDefinitions.get(uri);
    if (fileDefNames) {
        for (const name of fileDefNames) {
            const allDefs = rgbdsIndexer.allDefinitions.get(name);
            if (!allDefs || allDefs.length <= 1) continue;
            const thisDef = allDefs.find(d => d.file === uri);
            if (!thisDef || thisDef.type === 'section') continue;

            const otherFiles = allDefs
                .filter(d => d.file !== uri)
                .map(d => {
                    const parts = d.file.split('/');
                    return parts[parts.length - 1];
                });

            if (otherFiles.length > 0) {
                diagnostics.push({
                    range: Range.create(thisDef.line, thisDef.col, thisDef.line, thisDef.endCol),
                    severity: DiagnosticSeverity.Warning,
                    message: `Duplicate symbol "${name}" (also defined in ${otherFiles.join(', ')})`,
                    source: 'rgbds',
                });
            }
        }
    }

    // Validate hex byte annotations in comments against computed bytes
    if (validateCommentBytesEnabled) {
        const tree = rgbdsIndexer.getTree(uri);
        if (tree) {
            const mismatches = validateCommentBytes(
                tree,
                uri,
                rgbdsIndexer.definitions,
                (u) => rgbdsIndexer.getOrParseTree(u),
                (str, line) => {
                    const charmap = rgbdsIndexer.getActiveCharmap(uri, line);
                    return charmap ? rgbdsIndexer.encodeStringBytes(charmap, str) : null;
                },
            );
            for (const m of mismatches) {
                diagnostics.push({
                    range: Range.create(m.line, m.commentCol, m.line, m.commentEndCol),
                    severity: DiagnosticSeverity.Warning,
                    message: `Byte mismatch: comment has ${formatBytesFlat(m.commentBytes)}, expected ${formatBytesFlat(m.computedBytes)}`,
                    source: 'rgbds',
                });
            }
        }
    }

    return diagnostics;
}

// ─── Utilities ────────────────────────────────────────────────

function getMteDefinitionAtCursor(
    uri: string,
    stringNode: Parser.SyntaxNode,
    position: { line: number; character: number },
): Location | null {
    const str = stripQuotes(stringNode.text);
    if (!str) return null;

    const activeCharmap = rgbdsIndexer.getActiveCharmap(uri, position.line);
    if (!activeCharmap) return null;

    const segments = rgbdsIndexer.encodeString(activeCharmap, str);
    if (!segments) return null;

    // Find which segment the cursor is on
    const strStartCol = stringNode.startPosition.column + 1;
    const cursorOffset = position.character - strStartCol;
    let pos = 0;
    for (const seg of segments) {
        if (cursorOffset >= pos && cursorOffset < pos + seg.source.length && seg.isMte) {
            // Look up the CHARMAP definition
            const entry = rgbdsIndexer.getCharmapEntryDef(activeCharmap, seg.source);
            if (entry) {
                return {
                    uri: entry.file,
                    range: Range.create(entry.line, 0, entry.line, 0),
                };
            }
        }
        pos += seg.source.length;
    }
    return null;
}

function getStringHover(uri: string, stringNode: Parser.SyntaxNode, line: number, cursorCol: number): Hover | null {
    const str = stripQuotes(stringNode.text);
    if (!str) return null;

    const activeCharmap = rgbdsIndexer.getActiveCharmap(uri, line);
    const segments = activeCharmap
        ? rgbdsIndexer.encodeString(activeCharmap, str)
        : null;

    let md = '';
    if (activeCharmap) {
        md += `**Charmap**: \`${activeCharmap}\`\n\n`;
    }

    if (segments && segments.length > 0) {
        const totalBytes = segments.reduce((sum, s) => sum + s.bytes.length, 0);
        md += `**Size**: ${totalBytes} byte${totalBytes !== 1 ? 's' : ''}\n\n`;

        // Find which segment the cursor is on
        const strStartCol = stringNode.startPosition.column + 1; // after opening quote
        const cursorOffset = cursorCol - strStartCol;
        let cursorSegCharPos = 0;
        let cursorSegment: typeof segments[0] | null = null;
        let pos = 0;
        for (const seg of segments) {
            if (cursorOffset >= pos && cursorOffset < pos + seg.source.length) {
                cursorSegment = seg;
                cursorSegCharPos = pos;
                break;
            }
            pos += seg.source.length;
        }

        // If cursor is on an MTE segment, show just that match
        if (cursorSegment && cursorSegment.isMte) {
            const hex = cursorSegment.bytes.map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
            md += `**MTE**: \`"${cursorSegment.source}"\` → \`${hex}\``;
            const segStart = strStartCol + cursorSegCharPos;
            return {
                contents: { kind: 'markdown', value: md },
                range: Range.create(line, segStart, line, segStart + cursorSegment.source.length),
            };
        }

        // Otherwise show full encoding breakdown
        const allHex = segments.flatMap(s => s.bytes).map(b => '$' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        md += `**Bytes**: \`${allHex}\``;
    }

    return { contents: { kind: 'markdown', value: md } };
}

function getSymbolAtPosition(doc: TextDocument, position: { line: number; character: number }): string | null {
    const tree = rgbdsIndexer.getOrParseTree(doc.uri);
    if (!tree) return null;

    const node = getNodeAtPosition(tree, position.line, position.character);
    if (!node) return null;

    // Walk up to find an identifier-like node inside a symbol_reference
    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (
            current.type === 'identifier' ||
            current.type === 'scoped_identifier' ||
            current.type === 'local_identifier'
        ) {
            break;
        }
        if (current.type === 'symbol_reference') {
            // Use the first named child
            current = current.firstNamedChild ?? current;
            break;
        }
        if (current.type === 'line' || current.type === 'final_line' || current.type === 'source_file') return null;
        current = current.parent;
    }
    if (!current) return null;

    // scoped_identifier already has the full "Global.local" text
    if (current.type === 'scoped_identifier') {
        return current.text;
    }

    let word = current.text;

    // For a bare local_identifier (.local), scope it using the enclosing global label
    if (word.startsWith('.')) {
        const globalLabel = findEnclosingGlobalLabel(tree, position.line);
        if (globalLabel) word = globalLabel + word;
    }

    return word;
}

/**
 * Walk the source_file's named children (lines) backwards from the given line
 * to find the most recent global label definition.
 */
function findEnclosingGlobalLabel(tree: Parser.Tree, line: number): string | null {
    const root = tree.rootNode;
    // Find the line node at or before the given line
    let lineNode: Parser.SyntaxNode | null = null;
    for (const child of root.namedChildren) {
        if (child.startPosition.row <= line) {
            lineNode = child;
        } else {
            break;
        }
    }

    // Walk backward through line nodes to find a global_label
    let current: Parser.SyntaxNode | null = lineNode;
    while (current) {
        // Look for label_definition > global_label in this line
        for (const child of current.namedChildren) {
            if (child.type === 'label_definition') {
                for (const labelChild of child.namedChildren) {
                    if (labelChild.type === 'global_label') {
                        const nameNode = labelChild.childForFieldName('name');
                        if (nameNode) return nameNode.text;
                    }
                }
            }
        }
        current = current.previousNamedSibling;
    }
    return null;
}

function getWordRangeAtPosition(doc: TextDocument, position: { line: number; character: number }): Range | null {
    const tree = rgbdsIndexer.getOrParseTree(doc.uri);
    if (!tree) return null;

    const node = getNodeAtPosition(tree, position.line, position.character);
    if (!node) return null;

    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (
            current.type === 'identifier' ||
            current.type === 'scoped_identifier' ||
            current.type === 'local_identifier'
        ) {
            break;
        }
        if (current.type === 'symbol_reference') {
            current = current.firstNamedChild ?? current;
            break;
        }
        if (current.type === 'line' || current.type === 'final_line' || current.type === 'source_file') return null;
        current = current.parent;
    }
    if (!current) return null;

    return Range.create(
        current.startPosition.row, current.startPosition.column,
        current.endPosition.row, current.endPosition.column,
    );
}


// Map directive node types (from grammar) to our doc keys
const DIRECTIVE_NODE_MAP: { [nodeType: string]: string } = {
    section_directive: 'section',
    load_directive: 'load',
    endsection_directive: 'endsection',
    data_directive: 'db', // resolved further by keyword text
    constant_directive: 'equ', // resolved further by keyword text
    include_directive: 'include',
    incbin_directive: 'incbin',
    export_directive: 'export',
    purge_directive: 'purge',
    macro_start: 'macro',
    endm_directive: 'endm',
    shift_directive: 'shift',
    if_directive: 'if',
    elif_directive: 'elif',
    else_directive: 'else',
    endc_directive: 'endc',
    rept_directive: 'rept',
    for_directive: 'for',
    endr_directive: 'endr',
    break_directive: 'break',
    endl_directive: 'endl',
    union_directive: 'union',
    nextu_directive: 'nextu',
    endu_directive: 'endu',
    charmap_directive: 'charmap',
    newcharmap_directive: 'newcharmap',
    setcharmap_directive: 'setcharmap',
    pushc_directive: 'pushc',
    popc_directive: 'popc',
    pushs_directive: 'pushs',
    pops_directive: 'pops',
    pusho_directive: 'pusho',
    popo_directive: 'popo',
    opt_directive: 'opt',
    assert_directive: 'assert',
    print_directive: 'print',
    warn_directive: 'warn',
    fail_directive: 'fail',
    rsreset_directive: 'rsreset',
    rsset_directive: 'rsset',
    rb_directive: 'rb',
    rw_directive: 'rw',
};

function getDirectiveKeyword(node: Parser.SyntaxNode): string | null {
    // Walk up to find a directive node
    let walk: Parser.SyntaxNode | null = node;
    while (walk) {
        const key = DIRECTIVE_NODE_MAP[walk.type];
        if (key !== undefined) {
            // For directives with anonymous keywords, extract from source text
            if (walk.type === 'data_directive' || walk.type === 'constant_directive') {
                const txt = walk.text.trimStart().toLowerCase();
                const kwMatch = txt.match(/^(db|dw|dl|ds|equ|equs|set|def|redef)\b/i);
                if (kwMatch) return kwMatch[1].toLowerCase();
            }
            return key;
        }
        if (walk.type === 'line' || walk.type === 'final_line') break;
        walk = walk.parent;
    }
    return null;
}

documents.listen(connection);
connection.listen();
