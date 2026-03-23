#!/usr/bin/env node

// Catch startup crashes and write to stderr before exiting
process.on('uncaughtException', (err) => {
    process.stderr.write(`[rgbds-lsp] Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
});

import './server';
