import Parser from 'tree-sitter';
import { SymbolDef, SymbolRef } from './types';
import { pathToUri, collectRgbdsFiles } from './utils';
import * as fs from 'fs';

// Load tree-sitter-rgbds grammar
const rgbdsLanguage = require('tree-sitter-rgbds');

export class Indexer {
    public definitions: Map<string, SymbolDef> = new Map();
    public references: Map<string, SymbolRef[]> = new Map();

    private parser: Parser;
    private trees: Map<string, Parser.Tree> = new Map();
    private fileContents: Map<string, string> = new Map();
    private indexedFileUris: Set<string> = new Set();

    constructor() {
        this.parser = new Parser();
        this.parser.setLanguage(rgbdsLanguage);
    }

    public getIndexedFileUris(): string[] {
        return Array.from(this.indexedFileUris);
    }

    public getTree(uri: string): Parser.Tree | undefined {
        return this.trees.get(uri);
    }

    public clearAll(): void {
        this.definitions.clear();
        this.references.clear();
        this.trees.clear();
        this.fileContents.clear();
        this.indexedFileUris.clear();
    }

    public indexFile(uri: string, content: string): void {
        const oldTree = this.trees.get(uri);
        const tree = this.parser.parse(content, oldTree);
        this.trees.set(uri, tree);
        this.fileContents.set(uri, content);
        this.indexedFileUris.add(uri);
        this.rebuildIndex();
    }

    public indexProject(rootDir: string): { indexed: number; failed: number } {
        const files = collectRgbdsFiles(rootDir);
        let indexed = 0;
        let failed = 0;

        for (const filePath of files) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const uri = pathToUri(filePath);
                const tree = this.parser.parse(content);
                this.trees.set(uri, tree);
                this.fileContents.set(uri, content);
                this.indexedFileUris.add(uri);
                indexed++;
            } catch {
                failed++;
            }
        }

        this.rebuildIndex();
        return { indexed, failed };
    }

    public async indexProjectAsync(rootDir: string): Promise<{ indexed: number; failed: number }> {
        const files = collectRgbdsFiles(rootDir);
        let indexed = 0;
        let failed = 0;
        const BATCH_SIZE = 10;

        for (let i = 0; i < files.length; i++) {
            try {
                const content = fs.readFileSync(files[i], 'utf-8');
                const uri = pathToUri(files[i]);
                const tree = this.parser.parse(content);
                this.trees.set(uri, tree);
                this.fileContents.set(uri, content);
                this.indexedFileUris.add(uri);
                indexed++;
            } catch {
                failed++;
            }

            // Yield to the event loop every BATCH_SIZE files
            if ((i + 1) % BATCH_SIZE === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        this.rebuildIndex();
        return { indexed, failed };
    }

    private rebuildIndex(): void {
        this.definitions.clear();
        this.references.clear();

        for (const [uri, tree] of this.trees) {
            this.extractSymbols(uri, tree);
        }
    }

    private extractSymbols(uri: string, tree: Parser.Tree): void {
        let currentGlobal = '';

        for (const lineNode of tree.rootNode.children) {
            // Handle both 'line' and 'final_line' (EOF without newline)
            if (lineNode.type !== 'line' && lineNode.type !== 'final_line') continue;

            for (const child of lineNode.children) {
                if (child.type === 'label_definition') {
                    this.extractLabel(uri, child, currentGlobal);
                    const labelNode = child.firstChild;
                    if (labelNode?.type === 'global_label') {
                        const nameNode = labelNode.childForFieldName('name');
                        if (nameNode) currentGlobal = nameNode.text;
                    }
                } else if (child.type === 'statement') {
                    // Unwrap the statement node to reach the actual content
                    for (const stmt of child.children) {
                        this.processStatement(uri, stmt, currentGlobal);
                    }
                } else if (child.type === 'directive') {
                    this.extractDirectiveSymbols(uri, child, currentGlobal);
                } else if (child.type === 'instruction') {
                    this.extractReferences(uri, child, currentGlobal);
                } else if (child.type === 'macro_invocation') {
                    this.extractReferences(uri, child, currentGlobal);
                }
            }
        }
    }

    private processStatement(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        if (node.type === 'directive') {
            this.extractDirectiveSymbols(uri, node, currentGlobal);
        } else if (node.type === 'instruction') {
            this.extractReferences(uri, node, currentGlobal);
        } else if (node.type === 'macro_invocation') {
            this.extractReferences(uri, node, currentGlobal);
        }
    }

    private extractLabel(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        const labelNode = node.firstChild;
        if (!labelNode) return;

        if (labelNode.type === 'global_label') {
            const nameNode = labelNode.childForFieldName('name');
            if (!nameNode) return;
            const name = nameNode.text;
            this.definitions.set(name, {
                name,
                type: 'label',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: labelNode.children.some(c => c.text === '::'),
            });
        } else if (labelNode.type === 'local_label') {
            const nameNode = labelNode.childForFieldName('name');
            if (!nameNode) return;
            const localName = nameNode.text; // .something
            const scopedName = currentGlobal ? `${currentGlobal}${localName}` : localName;
            this.definitions.set(scopedName, {
                name: scopedName,
                type: 'label',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: true,
                isExported: false,
                parentLabel: currentGlobal || undefined,
            });
        }
    }

    private extractDirectiveSymbols(uri: string, node: Parser.SyntaxNode, currentGlobal: string): void {
        const directive = node.firstChild;
        if (!directive) return;

        if (directive.type === 'constant_directive') {
            const nameNode = directive.childForFieldName('name');
            if (!nameNode) return;
            const name = nameNode.text;
            // Determine if EQU, EQUS, or SET
            this.definitions.set(name, {
                name,
                type: 'constant',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: false,
            });
            // Extract references from the value expression
            for (const child of directive.children) {
                if (child.type === 'expression') {
                    this.extractReferences(uri, child, currentGlobal);
                }
            }
        } else if (directive.type === 'macro_start') {
            const nameNode = directive.childForFieldName('name');
            if (!nameNode) return;
            this.definitions.set(nameNode.text, {
                name: nameNode.text,
                type: 'macro',
                file: uri,
                line: nameNode.startPosition.row,
                col: nameNode.startPosition.column,
                endCol: nameNode.endPosition.column,
                isLocal: false,
                isExported: false,
            });
        } else if (directive.type === 'section_directive') {
            // Extract section name from the string
            const stringNode = directive.children.find(c => c.type === 'string');
            if (stringNode) {
                const rawText = stringNode.text;
                const name = rawText.slice(1, -1); // strip quotes
                this.definitions.set(name, {
                    name,
                    type: 'section',
                    file: uri,
                    line: stringNode.startPosition.row,
                    col: stringNode.startPosition.column,
                    endCol: stringNode.endPosition.column,
                    isLocal: false,
                    isExported: false,
                });
            }
            // Extract references from expressions in section
            this.extractChildReferences(uri, directive, currentGlobal);
        } else if (directive.type === 'data_directive' || directive.type === 'if_directive' ||
                   directive.type === 'elif_directive' || directive.type === 'rept_directive' ||
                   directive.type === 'assert_directive') {
            this.extractChildReferences(uri, directive, currentGlobal);
        } else if (directive.type === 'include_directive') {
            // No symbol extraction needed for includes
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

    private addRef(name: string, ref: SymbolRef): void {
        let refs = this.references.get(name);
        if (!refs) {
            refs = [];
            this.references.set(name, refs);
        }
        // Avoid duplicates on same line/col
        if (!refs.some(r => r.file === ref.file && r.line === ref.line && r.col === ref.col)) {
            refs.push(ref);
        }
    }
}

export const rgbdsIndexer = new Indexer();
