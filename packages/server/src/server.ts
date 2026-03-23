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
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { rgbdsIndexer } from './indexer';
import { uriToPath, pathToUri } from './utils';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let pendingWorkspaceFolders: string[] = [];

connection.onInitialize((params: InitializeParams) => {
    // Collect workspace folders for background indexing after handshake
    if (params.workspaceFolders) {
        for (const folder of params.workspaceFolders) {
            pendingWorkspaceFolders.push(uriToPath(folder.uri));
        }
    }

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            completionProvider: { resolveProvider: false },
            renameProvider: { prepareProvider: true },
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
    connection.console.log('RGBDS Language Server initialized');

    // Index workspace folders in the background after the handshake completes
    const folders = [...pendingWorkspaceFolders];
    pendingWorkspaceFolders = [];
    (async () => {
        for (const folderPath of folders) {
            const result = await rgbdsIndexer.indexProjectAsync(folderPath);
            connection.console.log(`Indexed workspace: ${folderPath} (${rgbdsIndexer.definitions.size} definitions, ${result.indexed} files)`);
        }
    })();
});

// Reindex on file change
documents.onDidChangeContent(change => {
    rgbdsIndexer.indexFile(change.document.uri, change.document.getText());

    // Send diagnostics
    const diagnostics = computeDiagnostics(change.document);
    connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

// ─── Go to Definition ─────────────────────────────────────────

connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

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

    const symbol = getSymbolAtPosition(doc, params.position);
    if (!symbol) return null;

    const def = rgbdsIndexer.definitions.get(symbol);
    if (!def) return null;

    const refs = rgbdsIndexer.references.get(symbol) || [];
    let md = `**${def.name}** _(${def.type})_\n\n`;
    md += `Defined in \`${path.basename(uriToPath(def.file))}\` line ${def.line + 1}`;
    if (def.isExported) md += ' _(exported)_';
    if (refs.length > 0) md += `\n\n${refs.length} reference${refs.length === 1 ? '' : 's'}`;

    return { contents: { kind: 'markdown', value: md } };
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

// ─── Completion ───────────────────────────────────────────────

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
    const items: CompletionItem[] = [];

    for (const [name, def] of rgbdsIndexer.definitions) {
        let kind: CompletionItemKind = CompletionItemKind.Variable;
        if (def.type === 'label') kind = CompletionItemKind.Function;
        else if (def.type === 'constant') kind = CompletionItemKind.Constant;
        else if (def.type === 'macro') kind = CompletionItemKind.Method;
        else if (def.type === 'section') kind = CompletionItemKind.Module;

        items.push({
            label: name,
            kind,
            detail: `${def.type} — ${path.basename(uriToPath(def.file))}:${def.line + 1}`,
        });
    }

    return items;
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
        return null;
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
    for (const [name, refs] of rgbdsIndexer.references) {
        if (rgbdsIndexer.definitions.has(name)) continue;

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

    // Find duplicate definitions in this file
    const seenInFile = new Map<string, number>();
    for (const [name, def] of rgbdsIndexer.definitions) {
        if (def.file !== uri) continue;
        if (def.type === 'section') continue; // sections can be duplicated
        // Check if another def with same name exists in a different file
        // (We only report if we find multiple defs with same name)
    }

    return diagnostics;
}

// ─── Utilities ────────────────────────────────────────────────

function getSymbolAtPosition(doc: TextDocument, position: { line: number; character: number }): string | null {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line];
    if (!lineText) return null;

    const wordRegex = /[a-zA-Z0-9_.]/;
    let start = position.character;
    let end = position.character;

    while (start > 0 && wordRegex.test(lineText[start - 1])) start--;
    while (end < lineText.length && wordRegex.test(lineText[end])) end++;

    if (start === end) return null;
    let word = lineText.substring(start, end);

    // If it's a local label reference (.something), scope it
    if (word.startsWith('.')) {
        let currentGlobal = '';
        for (let i = 0; i <= position.line; i++) {
            const m = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*::?/);
            if (m) currentGlobal = m[1];
        }
        if (currentGlobal) word = currentGlobal + word;
    }

    return word;
}

function getWordRangeAtPosition(doc: TextDocument, position: { line: number; character: number }): Range | null {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[position.line];
    if (!lineText) return null;

    const wordRegex = /[a-zA-Z0-9_.]/;
    let start = position.character;
    let end = position.character;

    while (start > 0 && wordRegex.test(lineText[start - 1])) start--;
    while (end < lineText.length && wordRegex.test(lineText[end])) end++;

    if (start === end) return null;
    return Range.create(position.line, start, position.line, end);
}

documents.listen(connection);
connection.listen();
