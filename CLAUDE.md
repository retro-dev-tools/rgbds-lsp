# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RGBDS-LSP is a Language Server Protocol implementation for RGBDS (Game Boy assembly). Monorepo: Tree-sitter grammar, LSP server, VS Code extension.

## Build Commands

```bash
npm install && npm run build          # Install and build everything
npm run clean                         # Clean all build artifacts

cd packages/tree-sitter-rgbds && npx tree-sitter generate  # Regenerate parser after grammar.js changes
cd packages/tree-sitter-rgbds && npx tree-sitter test      # Grammar corpus tests

cd packages/server && npm run build   # Build server (required before integration tests)
cd packages/server && npm test        # Unit + integration tests (vitest)
cd packages/server && npx vitest run tests/unit.test.ts     # Single test file

cd packages/vscode && npm run build   # Build extension
```

**Critical**: `tree-sitter generate` must run before `npm install` — the native addon build depends on `src/parser.c`. The root build script handles this.

**Integration tests** spawn `dist/index.js` as a subprocess — build the server first.

## Architecture

```
VS Code Extension (IPC client)  →  LSP Server (tree-sitter)  →  Tree-sitter Parser
packages/vscode                    packages/server               packages/tree-sitter-rgbds
```

- **Assembled bytes** are text decorations via custom `rgbds/assembledBytes` RPC — NOT inlay hints. The extension manages rendering.
- **Inlay hints** show constant values (`= $FF40`) and macro parameter labels (`\1:`). These are separate from assembled bytes.
- **Local labels** starting with `.` are stored as `GlobalLabel.local` in the index.
- **Symbol types**: `label`, `constant`, `macro`, `section`, `charmap`
- **Per-file reverse index**: `fileDefinitions`/`fileReferences` maps enable O(1) lookups. `allDefinitions` tracks all defs per name for duplicate detection.
- **Charmap state**: `extractAllCharmaps` is the single source of truth — runs after initial indexing and each reindex.
- **Indexer cache**: `~/.rgbds-lsp/cache/` keyed by workspace path hash. Clear after changing symbol extraction logic.

## Versioning

Each package versioned independently. Server and extension versions stay in sync. Tree-sitter version is independent.

Version locations: `packages/*/package.json`, `packages/tree-sitter-rgbds/tree-sitter.json`, `.claude-plugin/plugin.json` (bump with higher of server/extension).
