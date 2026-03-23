# rgbds-lsp

Language server and VS Code extension for [RGBDS](https://rgbds.gbdev.io/) Game Boy assembly.

## Features

- **Go to Definition** — jump to label, constant, or macro definitions
- **Find References** — find all usages across the project
- **Hover** — symbol type, location, reference count
- **Completion** — suggest known symbols while typing
- **Document Symbols** — outline tree with labels nested under sections
- **Rename** — cross-file symbol rename with validation
- **Diagnostics** — undefined symbol warnings
- **Syntax Highlighting** — full RGBDS syntax support

## Packages

| Package | Description |
|---------|-------------|
| [`tree-sitter-rgbds`](packages/tree-sitter-rgbds/) | Tree-sitter grammar for RGBDS assembly |
| [`rgbds-language-server`](packages/server/) | LSP server powered by tree-sitter |
| [`rgbds-lsp`](packages/vscode/) | VS Code extension |
| [`.claude-plugin`](.claude-plugin/) | Claude Code plugin |

## Architecture

```
VS Code / Claude Code  →  rgbds-language-server  →  tree-sitter-rgbds
```

The language server uses tree-sitter for parsing, producing a full syntax tree for each file. The indexer walks these trees to extract definitions and references across the project.

## Quick Start

### VS Code

Install the extension from the marketplace (coming soon), or build from source:

```bash
cd packages/vscode
npm install
npm run build
# Then open VS Code with: code --extensionDevelopmentPath=.
```

### Claude Code

```bash
claude plugin marketplace add minorum/rgbds-lsp
claude plugin install rgbds-lsp
```

The plugin installs the language server from npm automatically on first session and launches it for `.asm` and `.inc` files.

### Standalone

```bash
npm install -g rgbds-language-server
rgbds-language-server --stdio
```

## Development

```bash
git clone https://github.com/minorum/rgbds-lsp.git
cd rgbds-lsp
npm install

# Build everything
npm run build

# Run grammar tests
cd packages/tree-sitter-rgbds && npx tree-sitter test
```

## License

MIT
