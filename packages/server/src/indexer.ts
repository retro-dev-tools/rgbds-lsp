import Parser from 'tree-sitter';
import { SymbolDef, SymbolRef, IncludeRef, CharmapStateChange, CharmapSegment, CharmapEntry } from './types';
import { pathToUri, uriToPath, collectRgbdsFiles, stripQuotes } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Load tree-sitter-rgbds grammar
const rgbdsLanguage = require('@retro-dev/tree-sitter-rgbds');

const CACHE_VERSION = 2;
const CACHE_DIR = path.join(require('os').homedir(), '.rgbds-lsp', 'cache');

interface CacheEntry {
    hash: string;
    definitions: [string, SymbolDef][];
    references: [string, SymbolRef[]][];
    includes: [string, IncludeRef[]][];
}

interface CacheFile {
    version: number;
    files: { [filePath: string]: CacheEntry };
}

function contentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

function cachePath(rootDir: string): string {
    const key = crypto.createHash('md5').update(rootDir).digest('hex');
    return path.join(CACHE_DIR, `${key}.json`);
}

export class Indexer {
    public definitions: Map<string, SymbolDef> = new Map();
    public allDefinitions: Map<string, SymbolDef[]> = new Map();
    public references: Map<string, SymbolRef[]> = new Map();
    public includers: Map<string, IncludeRef[]> = new Map();
    public onLog: ((message: string) => void) | null = null;

    // Maps file URI → set of definition names defined in that file
    public fileDefinitions: Map<string, Set<string>> = new Map();
    // Maps file URI → set of reference names that have refs from that file
    public fileReferences: Map<string, Set<string>> = new Map();

    /** Charmap entries: charmap name → (source string → entry with bytes + location) */
    public charmapEntries: Map<string, Map<string, CharmapEntry>> = new Map();
    /** Active charmap state changes per file: file URI → sorted [{line, charmap}] */
    public charmapState: Map<string, CharmapStateChange[]> = new Map();
    /** Tracks which charmap CHARMAP entries are added to during indexing */
    private currentCharmapDef: string = '';

    private parser: Parser;
    private trees: Map<string, Parser.Tree> = new Map();
    private fileContents: Map<string, string> = new Map();
    private indexedFileUris: Set<string> = new Set();

    constructor() {
        this.parser = new Parser();
        this.parser.setLanguage(rgbdsLanguage);
    }

    private log(message: string): void {
        if (this.onLog) this.onLog(message);
    }

    public getIndexedFileUris(): string[] {
        return Array.from(this.indexedFileUris);
    }

    public getTree(uri: string): Parser.Tree | undefined {
        return this.trees.get(uri);
    }

    /** Get tree, parsing on-demand from cached content if needed. */
    public getOrParseTree(uri: string): Parser.Tree | undefined {
        let tree = this.trees.get(uri);
        if (tree) return tree;
        const content = this.fileContents.get(uri);
        if (content) {
            tree = this.parser.parse(content);
            this.trees.set(uri, tree);
            return tree;
        }
        return undefined;
    }

    public clearAll(): void {
        this.definitions.clear();
        this.allDefinitions.clear();
        this.references.clear();
        this.includers.clear();
        this.fileDefinitions.clear();
        this.fileReferences.clear();
        this.trees.clear();
        this.fileContents.clear();
        this.indexedFileUris.clear();
        this.charmapEntries.clear();
        this.charmapState.clear();
    }

    /** Get the active charmap name at a given file position */
    public getActiveCharmap(uri: string, line: number): string | null {
        const states = this.charmapState.get(uri);
        if (!states || states.length === 0) return null;
        // Find the last state change at or before this line
        let active: string | null = null;
        for (const s of states) {
            if (s.line <= line) active = s.charmap;
            else break;
        }
        return active;
    }

    /** A segment of a string encoded via charmap */
    public encodeString(charmapName: string, str: string): CharmapSegment[] | null {
        const entries = this.charmapEntries.get(charmapName);
        if (!entries) return null;

        const segments: CharmapSegment[] = [];
        let i = 0;
        while (i < str.length) {
            let matched = false;
            for (let len = Math.min(str.length - i, 64); len > 0; len--) {
                const substr = str.substring(i, i + len);
                const entry = entries.get(substr);
                if (entry) {
                    segments.push({ source: substr, bytes: entry.bytes, isMte: len > 1 });
                    i += len;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                segments.push({ source: str[i], bytes: [str.charCodeAt(i)], isMte: false });
                i++;
            }
        }
        return segments;
    }

    /** Get flat bytes from encoding */
    public encodeStringBytes(charmapName: string, str: string): number[] | null {
        const segments = this.encodeString(charmapName, str);
        if (!segments) return null;
        return segments.flatMap(s => s.bytes);
    }

    /** Look up the CHARMAP definition for a substring in a charmap */
    public getCharmapEntryDef(charmapName: string, substr: string): CharmapEntry | null {
        return this.charmapEntries.get(charmapName)?.get(substr) || null;
    }

    public indexFile(uri: string, content: string): void {
        const oldTree = this.trees.get(uri);
        const tree = this.parser.parse(content, oldTree);
        this.trees.set(uri, tree);
        this.fileContents.set(uri, content);
        this.indexedFileUris.add(uri);
        this.reindexFile(uri, tree);
    }

    /** Remove symbols for a single file and re-extract them. */
    private reindexFile(uri: string, tree: Parser.Tree): void {
        this.fileDefinitions.delete(uri);
        this.fileReferences.delete(uri);
        // Remove old definitions from this file
        for (const [name, def] of Array.from(this.definitions)) {
            if (def.file === uri) this.definitions.delete(name);
        }
        // Remove old allDefinitions entries from this file
        for (const [name, defs] of Array.from(this.allDefinitions)) {
            const filtered = defs.filter(d => d.file !== uri);
            if (filtered.length === 0) this.allDefinitions.delete(name);
            else this.allDefinitions.set(name, filtered);
        }
        // Remove old references from this file
        for (const [name, refs] of Array.from(this.references)) {
            const filtered = refs.filter(r => r.file !== uri);
            if (filtered.length === 0) {
                this.references.delete(name);
            } else {
                this.references.set(name, filtered);
            }
        }
        // Remove old include records from this file
        for (const [target, refs] of Array.from(this.includers)) {
            const filtered = refs.filter(r => r.from !== uri);
            if (filtered.length === 0) {
                this.includers.delete(target);
            } else {
                this.includers.set(target, filtered);
            }
        }
        // Re-extract symbols for this file only
        this.extractSymbols(uri, tree);
        // Rebuild charmap state for all files (charmap state can depend on other files)
        this.extractAllCharmaps();
    }

    public async indexProjectAsync(rootDir: string): Promise<{ indexed: number; failed: number }> {
        const t0 = Date.now();
        const files = collectRgbdsFiles(rootDir);
        const tScan = Date.now();
        this.log(`Found ${files.length} .asm/.inc files in ${rootDir} (${tScan - t0}ms)`);

        // Load cache
        const cacheFile = cachePath(rootDir);
        const cache = this.loadCache(cacheFile);
        const tCache = Date.now();
        if (cache) this.log(`Cache loaded (${tCache - tScan}ms)`);
        let indexed = 0;
        let cached = 0;
        let failed = 0;

        for (let i = 0; i < files.length; i++) {
            try {
                const content = fs.readFileSync(files[i], 'utf-8');
                const uri = pathToUri(files[i]);
                const hash = contentHash(content);
                this.fileContents.set(uri, content);
                this.indexedFileUris.add(uri);

                // Check cache
                const entry = cache?.files[files[i]];
                if (entry && entry.hash === hash) {
                    // Restore from cache — skip parsing
                    for (const [name, def] of entry.definitions) {
                        this.definitions.set(name, def);
                        let allDefs = this.allDefinitions.get(name);
                        if (!allDefs) { allDefs = []; this.allDefinitions.set(name, allDefs); }
                        allDefs.push(def);
                        let fileDefs = this.fileDefinitions.get(uri);
                        if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); }
                        fileDefs.add(name);
                    }
                    for (const [name, refs] of entry.references) {
                        const existing = this.references.get(name);
                        if (existing) {
                            existing.push(...refs);
                        } else {
                            this.references.set(name, [...refs]);
                        }
                        let fileRefs = this.fileReferences.get(uri);
                        if (!fileRefs) { fileRefs = new Set(); this.fileReferences.set(uri, fileRefs); }
                        fileRefs.add(name);
                    }
                    if (entry.includes) {
                        for (const [target, refs] of entry.includes) {
                            const existing = this.includers.get(target);
                            if (existing) {
                                existing.push(...refs);
                            } else {
                                this.includers.set(target, [...refs]);
                            }
                        }
                    }
                    cached++;
                } else {
                    // Parse and extract
                    const tree = this.parser.parse(content);
                    this.trees.set(uri, tree);
                    this.extractSymbols(uri, tree);
                    indexed++;
                }
            } catch (e) {
                this.log(`Failed to index: ${files[i]} (${e})`);
                failed++;
            }

            // Log progress every 50 files
            const total = indexed + cached;
            if (total % 50 === 0 && total > 0) {
                this.log(`Indexing progress: ${total}/${files.length} files (${cached} cached, ${this.definitions.size} definitions so far)`);
            }

            // Yield to the event loop every 10 files so LSP requests can be served
            if (i % 10 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        const tIndex = Date.now();

        // Extract charmap data (needs trees, so parse on-demand for cached files)
        this.extractAllCharmaps();
        const tCharmap = Date.now();

        // Save cache for next startup
        this.saveCache(cacheFile, files);
        const tSave = Date.now();
        this.log(`Indexing: ${tIndex - tCache}ms (${cached} cached, ${indexed} parsed) | Charmaps: ${tCharmap - tIndex}ms | Cache save: ${tSave - tCharmap}ms | Total: ${tSave - t0}ms`);

        return { indexed: indexed + cached, failed };
    }

    /**
     * Scan all indexed files for charmap definitions and state.
     * Runs after initial indexing to ensure charmap data is available
     * even when files were loaded from cache (no extractSymbols call).
     */
    private extractAllCharmaps(): void {
        this.charmapEntries.clear();
        this.charmapState.clear();
        this.currentCharmapDef = '';

        for (const uri of this.indexedFileUris) {
            const tree = this.getOrParseTree(uri);
            if (!tree) continue;

            const charmapStack: string[] = [];
            const fileCharmapState: CharmapStateChange[] = [];

            for (const lineNode of tree.rootNode.children) {
                if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;
                const line = lineNode.startPosition.row;

                for (const child of lineNode.namedChildren) {
                    if (child.type === 'statement') {
                        for (const stmt of child.children) {
                            this.trackCharmapState(stmt, line, uri, fileCharmapState, charmapStack);
                        }
                    } else if (child.type === 'directive') {
                        this.trackCharmapState(child, line, uri, fileCharmapState, charmapStack);
                    }
                }
            }

            if (fileCharmapState.length > 0) {
                this.charmapState.set(uri, fileCharmapState);
            }
        }

        let totalEntries = 0;
        for (const [, entries] of this.charmapEntries) totalEntries += entries.size;
        this.log(`Charmap data: ${this.charmapEntries.size} charmaps, ${totalEntries} entries, ${this.charmapState.size} files with state`);
    }

    private loadCache(cachePath: string): CacheFile | null {
        try {
            const raw = fs.readFileSync(cachePath, 'utf-8');
            const data = JSON.parse(raw) as CacheFile;
            if (data.version !== CACHE_VERSION) return null;
            return data;
        } catch {
            return null;
        }
    }

    private saveCache(cachePath: string, files: string[]): void {
        const cache: CacheFile = { version: CACHE_VERSION, files: {} };

        for (const filePath of files) {
            const uri = pathToUri(filePath);
            const content = this.fileContents.get(uri);
            if (!content) continue;

            // Collect definitions and references for this file
            const fileDefs: [string, SymbolDef][] = [];
            const defNames = this.fileDefinitions.get(uri);
            if (defNames) {
                for (const name of defNames) {
                    const def = this.definitions.get(name);
                    if (def) fileDefs.push([name, def]);
                }
            }
            const fileRefs: [string, SymbolRef[]][] = [];
            const refNames = this.fileReferences.get(uri);
            if (refNames) {
                for (const name of refNames) {
                    const refs = this.references.get(name);
                    if (refs) {
                        const inFile = refs.filter(r => r.file === uri);
                        if (inFile.length > 0) fileRefs.push([name, inFile]);
                    }
                }
            }
            const fileIncludes: [string, IncludeRef[]][] = [];
            for (const [target, refs] of this.includers) {
                const fileOnly = refs.filter(r => r.from === uri);
                if (fileOnly.length > 0) fileIncludes.push([target, fileOnly]);
            }

            cache.files[filePath] = {
                hash: contentHash(content),
                definitions: fileDefs,
                references: fileRefs,
                includes: fileIncludes,
            };
        }

        try {
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, JSON.stringify(cache));
        } catch (e) {
            this.log(`Failed to write cache: ${e}`);
        }
    }

    private rebuildIndex(): void {
        this.definitions.clear();
        this.allDefinitions.clear();
        this.references.clear();
        this.fileDefinitions.clear();
        this.fileReferences.clear();

        for (const [uri, tree] of this.trees) {
            this.extractSymbols(uri, tree);
        }
    }

    private extractSymbols(uri: string, tree: Parser.Tree): void {
        let currentGlobal = '';
        let pendingComments: string[] = [];

        for (const lineNode of tree.rootNode.children) {
            // Handle both 'line' and 'final_line' (EOF without newline)
            if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

            // Check if this line is comment-only or blank
            const namedChildren = lineNode.namedChildren;
            const hasComment = namedChildren.length === 1 && namedChildren[0].type === 'comment';
            const isBlank = namedChildren.length === 0;

            if (hasComment) {
                const commentText = namedChildren[0].text;
                // Strip leading ; and optional space
                pendingComments.push(commentText.replace(/^;\s?/, ''));
                continue;
            }

            if (isBlank) {
                // Blank lines are OK — allow gaps between comments and definitions
                continue;
            }

            // This line has code — attach pending comments to any definition found
            const docComment = pendingComments.length > 0 ? pendingComments.join('\n') : undefined;
            pendingComments = [];

            for (const child of namedChildren) {
                if (child.type === 'label_definition') {
                    this.extractLabel(uri, child, currentGlobal, docComment);
                    const labelNode = child.firstChild;
                    if (labelNode?.type === 'global_label') {
                        const nameNode = labelNode.childForFieldName('name');
                        if (nameNode) currentGlobal = nameNode.text;
                    }
                } else if (child.type === 'statement') {
                    for (const stmt of child.children) {
                        this.processStatement(uri, stmt, currentGlobal, docComment);
                    }
                } else if (child.type === 'directive') {
                    this.extractDirectiveSymbols(uri, child, currentGlobal, docComment);
                } else if (child.type === 'instruction') {
                    this.extractReferences(uri, child, currentGlobal);
                } else if (child.type === 'macro_invocation') {
                    this.extractMacroInvocation(uri, child, currentGlobal);
                }
            }
        }
    }

    private processStatement(uri: string, node: Parser.SyntaxNode, currentGlobal: string, docComment?: string): void {
        if (node.type === 'directive') {
            this.extractDirectiveSymbols(uri, node, currentGlobal, docComment);
        } else if (node.type === 'instruction') {
            this.extractReferences(uri, node, currentGlobal);
        } else if (node.type === 'macro_invocation') {
            this.extractMacroInvocation(uri, node, currentGlobal);
        }
    }

    private extractMacroInvocation(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        // The first identifier is the macro name — add as reference
        const macroName = node.namedChildren.find(c => c.type === 'identifier');
        if (macroName) {
            this.addRef(macroName.text, {
                name: macroName.text,
                file: uri,
                line: macroName.startPosition.row,
                col: macroName.startPosition.column,
                endCol: macroName.endPosition.column,
            });
        }
        // Also extract references from operand expressions
        this.extractReferences(uri, node, currentGlobal);
    }

    private trackCharmapState(
        node: Parser.SyntaxNode,
        line: number,
        uri: string,
        fileCharmapState: CharmapStateChange[],
        charmapStack: string[],
    ): void {
        // Walk into directive nodes
        const directive = node.type === 'directive'
            ? node.namedChildren[0]
            : node.namedChildren.find(c => c.type === 'directive')?.namedChildren[0];
        if (!directive) return;

        if (directive.type === 'newcharmap_directive') {
            const ids = directive.namedChildren.filter(c => c.type === 'identifier');
            const name = ids[0]?.text;
            if (!name) return;
            this.currentCharmapDef = name;
            // Create charmap entries map, optionally copying from base
            const baseCharmap = ids[1]?.text;
            const baseEntries = baseCharmap ? this.charmapEntries.get(baseCharmap) : undefined;
            this.charmapEntries.set(name, new Map(baseEntries || []));
        } else if (directive.type === 'charmap_directive') {
            // AST: charmap_directive → expression(string) + expression_list(byte values)
            const strExpr = directive.namedChildren.find(c => c.type === 'expression');
            const strChild = strExpr?.namedChildren.find(c => c.type === 'string');
            if (!strChild) return;
            const str = stripQuotes(strChild.text);

            const exprList = directive.children.find(c => c.type === 'expression_list');
            if (!exprList) return;
            const bytes: number[] = [];
            for (const child of exprList.namedChildren) {
                if (child.type === 'expression') {
                    const val = this.parseNumber(child.text.trim());
                    if (val !== null) bytes.push(val);
                }
            }

            if (bytes.length > 0 && this.currentCharmapDef) {
                this.charmapEntries.get(this.currentCharmapDef)?.set(str, {
                    source: str,
                    bytes,
                    file: uri,
                    line: directive.startPosition.row,
                });
            }
        } else if (directive.type === 'setcharmap_directive') {
            const nameNode = directive.namedChildren.find(c => c.type === 'identifier');
            if (nameNode) {
                fileCharmapState.push({ line, charmap: nameNode.text });
                // SETCHARMAP also changes which charmap receives new CHARMAP entries
                this.currentCharmapDef = nameNode.text;
            }
        } else if (directive.type === 'pushc_directive') {
            // Push current charmap state
            const current = fileCharmapState.length > 0
                ? fileCharmapState[fileCharmapState.length - 1].charmap
                : '';
            charmapStack.push(current);
        } else if (directive.type === 'popc_directive') {
            const restored = charmapStack.pop() || '';
            if (restored) {
                fileCharmapState.push({ line, charmap: restored });
            }
        }
    }

    private parseNumber(text: string): number | null {
        const t = text.trim();
        if (/^\d+$/.test(t)) return parseInt(t, 10);
        if (/^\$[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(1), 16);
        if (/^0x[0-9a-fA-F]+$/i.test(t)) return parseInt(t, 16);
        if (/^%[01]+$/.test(t)) return parseInt(t.slice(1), 2);
        return null;
    }

    private extractLabel(uri: string, node: Parser.SyntaxNode, currentGlobal: string, docComment?: string): void {
        const labelNode = node.firstChild;
        if (!labelNode) return;

        if (labelNode.type === 'global_label') {
            const nameNode = labelNode.childForFieldName('name');
            if (!nameNode) return;
            const name = nameNode.text;
            this.addDef(name, {
                name,
                type: 'label',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: labelNode.children.some(c => c.text === '::'),
                docComment,
            });
            let fileDefs = this.fileDefinitions.get(uri);
            if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); }
            fileDefs.add(name);
        } else if (labelNode.type === 'local_label') {
            const nameNode = labelNode.childForFieldName('name');
            if (!nameNode) return;
            const localName = nameNode.text; // .something
            const scopedName = currentGlobal ? `${currentGlobal}${localName}` : localName;
            this.addDef(scopedName, {
                name: scopedName,
                type: 'label',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: true,
                isExported: false,
                parentLabel: currentGlobal || undefined,
                docComment,
            });
            let fileDefs = this.fileDefinitions.get(uri);
            if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); }
            fileDefs.add(scopedName);
        }
    }

    private extractDirectiveSymbols(uri: string, node: Parser.SyntaxNode, currentGlobal: string, docComment?: string): void {
        const directive = node.firstChild;
        if (!directive) return;

        if (directive.type === 'constant_directive') {
            const nameNode = directive.childForFieldName('name');
            if (!nameNode) return;
            const name = nameNode.text;
            // Extract the value expression text
            const exprNode = directive.namedChildren.find(c => c.type === 'expression');
            const value = exprNode?.text;
            this.addDef(name, {
                name,
                type: 'constant',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: false,
                docComment,
                value,
            });
            { let fileDefs = this.fileDefinitions.get(uri); if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); } fileDefs.add(name); }
            // Extract references from the value expression
            for (const child of directive.children) {
                if (child.type === 'expression') {
                    this.extractReferences(uri, child, currentGlobal);
                }
            }
        } else if (directive.type === 'macro_start') {
            const nameNode = directive.childForFieldName('name');
            if (!nameNode) return;
            this.addDef(nameNode.text, {
                name: nameNode.text,
                type: 'macro',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: false,
                docComment,
            });
            { let fileDefs = this.fileDefinitions.get(uri); if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); } fileDefs.add(nameNode.text); }
        } else if (directive.type === 'section_directive') {
            // Extract section name from the string
            const stringNode = directive.children.find(c => c.type === 'string');
            if (stringNode) {
                const name = stripQuotes(stringNode.text);
                this.addDef(name, {
                    name,
                    type: 'section',
                    file: uri,
                    line: stringNode.startPosition.row,
                    col: stringNode.startPosition.column,
                    endCol: stringNode.endPosition.column,
                    isLocal: false,
                    isExported: false,
                    docComment,
                });
                { let fileDefs = this.fileDefinitions.get(uri); if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); } fileDefs.add(name); }
            }
            // Extract references from expressions in section
            this.extractChildReferences(uri, directive, currentGlobal);
        } else if (directive.type === 'data_directive' || directive.type === 'if_directive' ||
                   directive.type === 'elif_directive' || directive.type === 'rept_directive' ||
                   directive.type === 'assert_directive') {
            this.extractChildReferences(uri, directive, currentGlobal);
        } else if (directive.type === 'include_directive') {
            // Record include relationship
            const stringNode = directive.namedChildren.find(c => c.type === 'string');
            if (stringNode) {
                const raw = stripQuotes(stringNode.text);
                const filePath = uriToPath(uri);
                const resolved = path.resolve(path.dirname(filePath), raw);
                const targetUri = pathToUri(resolved);

                let refs = this.includers.get(targetUri);
                if (!refs) {
                    refs = [];
                    this.includers.set(targetUri, refs);
                }
                refs.push({
                    from: uri,
                    line: stringNode.startPosition.row,
                    col: stringNode.startPosition.column,
                    endCol: stringNode.endPosition.column,
                });
            }
        } else if (directive.type === 'setcharmap_directive') {
            // SETCHARMAP references a charmap name
            const nameNode = directive.namedChildren.find(c => c.type === 'identifier');
            if (nameNode) {
                this.addRef(nameNode.text, {
                    name: nameNode.text,
                    file: uri,
                    line: nameNode.startPosition.row,
                    col: nameNode.startPosition.column,
                    endCol: nameNode.endPosition.column,
                });
            }
        } else if (directive.type === 'newcharmap_directive') {
            // NEWCHARMAP defines a charmap name
            const nameNode = directive.namedChildren.find(c => c.type === 'identifier');
            if (nameNode) {
                this.addDef(nameNode.text, {
                    name: nameNode.text,
                    type: 'charmap',
                    file: uri,
                    line: nameNode.startPosition.row,
                    col: nameNode.startPosition.column,
                    endCol: nameNode.endPosition.column,
                    isLocal: false,
                    isExported: false,
                    docComment,
                });
                { let fileDefs = this.fileDefinitions.get(uri); if (!fileDefs) { fileDefs = new Set(); this.fileDefinitions.set(uri, fileDefs); } fileDefs.add(nameNode.text); }
            }
        } else if (directive.type === 'export_directive' || directive.type === 'purge_directive') {
            // EXPORT/PURGE reference symbol names
            for (const child of directive.namedChildren) {
                if (child.type === 'identifier') {
                    this.addRef(child.text, {
                        name: child.text,
                        file: uri,
                        line: child.startPosition.row,
                        col: child.startPosition.column,
                        endCol: child.endPosition.column,
                    });
                }
            }
        } else {
            // For other directives, scan for symbol references
            this.extractChildReferences(uri, directive, currentGlobal);
        }
    }

    private extractChildReferences(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        for (const child of node.children) {
            this.extractReferences(uri, child, currentGlobal);
        }
    }

    private extractReferences(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        if (node.type === 'symbol_reference') {
            this.extractSymbolRef(uri, node, currentGlobal);
            return;
        }

        for (const child of node.children) {
            this.extractReferences(uri, child, currentGlobal);
        }
    }

    private extractSymbolRef(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        // symbol_reference can be: identifier, local_identifier, identifier+local_identifier, or anonymous ref
        const children = node.children;

        if (children.length === 2 && children[0].type === 'identifier' && children[1].type === 'local_identifier') {
            // GlobalLabel.local form
            const fullName = children[0].text + children[1].text;
            this.addRef(fullName, {
                name: fullName,
                file: uri,
                line: node.startPosition.row,
                col: node.startPosition.column,
                endCol: node.endPosition.column,
            });
            // Also add ref to the global part
            this.addRef(children[0].text, {
                name: children[0].text,
                file: uri,
                line: children[0].startPosition.row,
                col: children[0].startPosition.column,
                endCol: children[0].endPosition.column,
            });
        } else if (children.length === 1) {
            const child = children[0];
            if (child.type === 'identifier') {
                this.addRef(child.text, {
                    name: child.text,
                    file: uri,
                    line: child.startPosition.row,
                    col: child.startPosition.column,
                    endCol: child.endPosition.column,
                });
            } else if (child.type === 'local_identifier') {
                const localName = child.text;
                const scopedName = currentGlobal ? `${currentGlobal}${localName}` : localName;
                this.addRef(scopedName, {
                    name: scopedName,
                    file: uri,
                    line: child.startPosition.row,
                    col: child.startPosition.column,
                    endCol: child.endPosition.column,
                });
            }
        }
    }

    private addDef(name: string, def: SymbolDef): void {
        this.definitions.set(name, def);
        let allDefs = this.allDefinitions.get(name);
        if (!allDefs) { allDefs = []; this.allDefinitions.set(name, allDefs); }
        allDefs.push(def);
    }

    private addRef(name: string, ref: SymbolRef): void {
        let refs = this.references.get(name);
        if (!refs) {
            refs = [];
            this.references.set(name, refs);
        }
        // Avoid duplicates on same line/col
        if (!refs.some(r => r.file === ref.file && r.line === ref.line && r.col === ref.col)) {
            refs.push(ref);
            let fileRefs = this.fileReferences.get(ref.file);
            if (!fileRefs) { fileRefs = new Set(); this.fileReferences.set(ref.file, fileRefs); }
            fileRefs.add(name);
        }
    }

    /** Remove all indexed data for files under the given folder path. */
    public removeFolder(folderPath: string): void {
        const folderUri = pathToUri(folderPath);
        // Remove all definitions from files in this folder
        for (const [uri, defNames] of Array.from(this.fileDefinitions)) {
            if (uri.startsWith(folderUri)) {
                for (const name of defNames) {
                    this.definitions.delete(name);
                    const allDefs = this.allDefinitions.get(name);
                    if (allDefs) {
                        const filtered = allDefs.filter(d => !d.file.startsWith(folderUri));
                        if (filtered.length === 0) this.allDefinitions.delete(name);
                        else this.allDefinitions.set(name, filtered);
                    }
                }
                this.fileDefinitions.delete(uri);
            }
        }
        // Remove all references from files in this folder
        for (const [uri, refNames] of Array.from(this.fileReferences)) {
            if (uri.startsWith(folderUri)) {
                for (const name of refNames) {
                    const refs = this.references.get(name);
                    if (refs) {
                        const filtered = refs.filter(r => !r.file.startsWith(folderUri));
                        if (filtered.length === 0) this.references.delete(name);
                        else this.references.set(name, filtered);
                    }
                }
                this.fileReferences.delete(uri);
            }
        }
        // Clean up trees and file contents
        for (const uri of Array.from(this.trees.keys())) {
            if (uri.startsWith(folderUri)) {
                this.trees.delete(uri);
                this.fileContents.delete(uri);
            }
        }
        // Clean up indexed file URIs
        for (const uri of Array.from(this.indexedFileUris)) {
            if (uri.startsWith(folderUri)) {
                this.indexedFileUris.delete(uri);
            }
        }
        // Clean up includers
        for (const [target, refs] of Array.from(this.includers)) {
            const filtered = refs.filter(r => !r.from.startsWith(folderUri));
            if (filtered.length === 0) this.includers.delete(target);
            else this.includers.set(target, filtered);
        }
    }
}

export const rgbdsIndexer = new Indexer();
