#!/usr/bin/env node
/**
 * Diagnostic script to verify the language server can start.
 * Usage: node dist/check.js
 */

console.log('rgbds-lsp diagnostic check');
console.log('Node version:', process.version);
console.log('Platform:', process.platform, process.arch);

try {
    require('tree-sitter');
    console.log('✓ tree-sitter loaded');
} catch (e: any) {
    console.error('✗ tree-sitter failed:', e.message);
    process.exit(1);
}

try {
    require('@retro-dev/tree-sitter-rgbds');
    console.log('✓ @retro-dev/tree-sitter-rgbds loaded');
} catch (e: any) {
    console.error('✗ @retro-dev/tree-sitter-rgbds failed:', e.message);
    console.error('  (native module may need rebuilding: npm rebuild)');
    process.exit(1);
}

try {
    const Parser = require('tree-sitter');
    const lang = require('tree-sitter-rgbds');
    const p = new Parser();
    p.setLanguage(lang);
    const tree = p.parse('Main:\n  ld a, b\n  ret\n');
    const root = tree.rootNode;
    console.log('✓ parser works (' + root.childCount + ' top-level nodes)');
} catch (e: any) {
    console.error('✗ parser test failed:', e.message);
    process.exit(1);
}

try {
    require('vscode-languageserver/node');
    console.log('✓ vscode-languageserver loaded');
} catch (e: any) {
    console.error('✗ vscode-languageserver failed:', e.message);
    process.exit(1);
}

console.log('\nAll checks passed — server should start correctly.');
