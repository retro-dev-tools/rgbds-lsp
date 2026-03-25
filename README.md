# rgbds-lsp

Language server for [RGBDS](https://rgbds.gbdev.io/) Game Boy assembly (`.asm`, `.inc` files). Works with VS Code, Neovim, Helix, and any LSP-compatible editor.

## Features

**Navigation** — go to definition, find references, clickable `INCLUDE`/`INCBIN` paths, document and workspace symbol search.

**Intelligence** — context-aware completion for instructions, directives, symbols, and file paths. Hover shows symbol info, numeric values in all bases, and SM83 instruction details (bytes, cycles, flags). Signature help shows macro parameter positions as you type arguments.

**Analysis** — diagnostics for undefined symbols and cross-file duplicates. Inlay hints resolve constant values inline (e.g. `= $FF40` after a constant reference).

**Editing** — cross-file rename, convert between hex/decimal/binary/octal literals, semantic highlighting, folding for blocks and comment regions.

**Assembled bytes** *(experimental, opt-in)* — hex byte decorations next to source lines, computed via static analysis of instructions, data directives, and macro expansion.

## Install

### VS Code

Install `rgbds-lsp` from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rgbds-lsp.rgbds-lsp), or build from source:

```bash
npm install && npm run build
cd packages/vscode && npx @vscode/vsce package -o rgbds-lsp.vsix --no-dependencies
code --install-extension packages/vscode/rgbds-lsp.vsix
```

### Claude Code

```bash
claude plugin marketplace add retro-dev-tools/rgbds-lsp
claude plugin install rgbds-lsp
```

### Standalone (Neovim, Helix, etc.)

Requires Node.js 18+.

```bash
npm install -g @retro-dev/rgbds-language-server
```

**Neovim** — add to your LSP config:

```lua
vim.lsp.start({
    name = 'rgbds',
    cmd = { 'rgbds-language-server', '--stdio' },
    filetypes = { 'rgbds', 'asm' },
    root_dir = vim.fs.dirname(vim.fs.find({ 'Makefile', '.git' }, { upward = true })[1]),
})
```

**Helix** — add to `languages.toml`:

```toml
[language-server.rgbds-lsp]
command = "rgbds-language-server"
args = ["--stdio"]

[[language]]
name = "asm"
language-servers = ["rgbds-lsp"]
file-types = ["asm", "inc"]
```

**Other editors** — run `rgbds-language-server --stdio` and configure for `*.asm`/`*.inc` files. The server needs a workspace folder for cross-file features.

## Project Structure

| Package | Description | npm |
|---|---|---|
| [tree-sitter-rgbds](packages/tree-sitter-rgbds/) | Tree-sitter grammar | `@retro-dev/tree-sitter-rgbds` |
| [server](packages/server/) | Language server | `@retro-dev/rgbds-language-server` |
| [vscode](packages/vscode/) | VS Code extension | — |

## Development

Requires Node.js 18+ and a C compiler (node-gyp builds the tree-sitter native addon).

```bash
git clone https://github.com/retro-dev-tools/rgbds-lsp.git && cd rgbds-lsp
npm install && npm run build

cd packages/server && npm test                              # unit + integration (vitest)
cd packages/tree-sitter-rgbds && npx tree-sitter test       # grammar corpus

cd packages/vscode && code --extensionDevelopmentPath="$(pwd)"  # launch dev extension host
```

## License

MIT
