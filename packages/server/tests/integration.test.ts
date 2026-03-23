import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LspTestClient } from './lsp-client';
import * as path from 'path';
import * as fs from 'fs';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const ROOT_URI = 'file:///' + FIXTURES.replace(/\\/g, '/');

function fileUri(name: string): string {
    return ROOT_URI + '/' + name;
}

describe('LSP integration', () => {
    let client: LspTestClient;

    beforeAll(async () => {
        client = new LspTestClient();
        await client.initialize(ROOT_URI);

        // Open fixture files so the server tracks them
        const mainContent = fs.readFileSync(path.join(FIXTURES, 'main.asm'), 'utf-8');
        client.openDocument(fileUri('main.asm'), mainContent);

        const utilsContent = fs.readFileSync(path.join(FIXTURES, 'utils.inc'), 'utf-8');
        client.openDocument(fileUri('utils.inc'), utilsContent);

        // Wait for background indexing to pick up fixture files
        // main.asm has: Main, InitSystem, PLAYER_MAX_HP, section "Main"
        // utils.inc has: SCREEN_WIDTH, SCREEN_HEIGHT, CopyBytes
        await client.waitForIndexing(5, 15000);
    }, 20000);

    afterAll(async () => {
        await client.shutdown();
    });

    describe('initialize', () => {
        it('should respond within timeout', async () => {
            // Already initialized in beforeAll — if we got here, it worked
            expect(true).toBe(true);
        });
    });

    describe('hover', () => {
        it('should return hover info for a label', async () => {
            // "Main" is on line 2 (0-indexed), col 0
            const result = await client.hover(fileUri('main.asm'), 2, 0) as any;
            expect(result).not.toBeNull();
            expect(result.contents.value).toContain('Main');
            expect(result.contents.value).toContain('label');
        });

        it('should return hover info for a constant', async () => {
            // PLAYER_MAX_HP is on line 15, col 0
            const result = await client.hover(fileUri('main.asm'), 15, 0) as any;
            expect(result).not.toBeNull();
            expect(result.contents.value).toContain('PLAYER_MAX_HP');
            expect(result.contents.value).toContain('constant');
        });

        it('should return null for empty space', async () => {
            const result = await client.hover(fileUri('main.asm'), 0, 50);
            expect(result).toBeNull();
        });
    });

    describe('go to definition', () => {
        it('should find definition of a called label', async () => {
            // "InitSystem" reference on line 3: "call InitSystem"
            const result = await client.definition(fileUri('main.asm'), 3, 10) as any;
            expect(result).not.toBeNull();
            expect(result.uri).toContain('main.asm');
            // InitSystem is defined on line 6
            expect(result.range.start.line).toBe(6);
        });

        it('should find definition of Main label', async () => {
            // "Main" reference on line 4: "jr Main"
            const result = await client.definition(fileUri('main.asm'), 4, 7) as any;
            expect(result).not.toBeNull();
            expect(result.range.start.line).toBe(2);
        });
    });

    describe('find references', () => {
        it('should find all references to a label', async () => {
            // "Main" defined line 2, referenced line 4
            const result = await client.references(fileUri('main.asm'), 2, 0) as any[];
            expect(result.length).toBeGreaterThanOrEqual(2); // def + ref
        });

        it('should find references to InitSystem', async () => {
            const result = await client.references(fileUri('main.asm'), 6, 0) as any[];
            expect(result.length).toBeGreaterThanOrEqual(2); // def + call
        });
    });

    describe('completion', () => {
        it('should return all project symbols', async () => {
            const result = await client.completion(fileUri('main.asm'), 3, 10) as any[];
            expect(result.length).toBeGreaterThan(0);
            const names = result.map((r: any) => r.label);
            expect(names).toContain('Main');
            expect(names).toContain('InitSystem');
            expect(names).toContain('PLAYER_MAX_HP');
        });

        it('should include symbols from other files', async () => {
            const result = await client.completion(fileUri('main.asm'), 3, 10) as any[];
            const names = result.map((r: any) => r.label);
            expect(names).toContain('CopyBytes');
            expect(names).toContain('SCREEN_WIDTH');
        });
    });

    describe('document symbols', () => {
        it('should return symbols for main.asm', async () => {
            const result = await client.documentSymbol(fileUri('main.asm')) as any[];
            expect(result.length).toBeGreaterThan(0);
            const names = result.map((s: any) => s.name);
            expect(names).toContain('Main');
            expect(names).toContain('InitSystem');
            expect(names).toContain('PLAYER_MAX_HP');
        });

        it('should nest local labels under globals', async () => {
            const result = await client.documentSymbol(fileUri('main.asm')) as any[];
            const initSystem = result.find((s: any) => s.name === 'InitSystem');
            expect(initSystem).toBeDefined();
            expect(initSystem.children.length).toBeGreaterThan(0);
            expect(initSystem.children[0].name).toContain('waitVBlank');
        });
    });

    describe('rename', () => {
        it('should rename a label across references', async () => {
            // Rename "Main" (line 2, col 0)
            const result = await client.rename(fileUri('main.asm'), 2, 0, 'EntryPoint') as any;
            expect(result).not.toBeNull();
            expect(result.changes).toBeDefined();
            // Should have edits in main.asm (definition + jr reference)
            const mainEdits = result.changes[fileUri('main.asm')];
            expect(mainEdits.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('incremental reindex', () => {
        it('should update symbols when a file changes', async () => {
            // Verify InitSystem exists before the change
            const hoverBefore = await client.hover(fileUri('main.asm'), 3, 10) as any;
            expect(hoverBefore).not.toBeNull();
            expect(hoverBefore.contents.value).toContain('InitSystem');

            // "Edit" the file: rename InitSystem to BootSystem
            const newContent = fs.readFileSync(path.join(FIXTURES, 'main.asm'), 'utf-8')
                .replace(/InitSystem/g, 'BootSystem');
            client.openDocument(fileUri('main.asm'), newContent);

            // Small delay for server to process the didChange
            await new Promise(r => setTimeout(r, 200));

            // Old name should no longer resolve
            // "call InitSystem" was on line 3 — now it says "call BootSystem"
            // Hover on the new name at the definition (line 6, col 0)
            const hoverNew = await client.hover(fileUri('main.asm'), 6, 0) as any;
            expect(hoverNew).not.toBeNull();
            expect(hoverNew.contents.value).toContain('BootSystem');

            // Completion should have BootSystem, not InitSystem
            const completion = await client.completion(fileUri('main.asm'), 0, 0) as any[];
            const names = completion.map((c: any) => c.label);
            expect(names).toContain('BootSystem');
            expect(names).not.toContain('InitSystem');

            // Symbols from other files should still be intact
            expect(names).toContain('CopyBytes');
            expect(names).toContain('SCREEN_WIDTH');

            // Restore original content
            const original = fs.readFileSync(path.join(FIXTURES, 'main.asm'), 'utf-8');
            client.openDocument(fileUri('main.asm'), original);
        }, 15000);

        it('should not lose cross-file symbols on single file reindex', async () => {
            // Count total symbols before
            const before = await client.completion(fileUri('main.asm'), 0, 0) as any[];
            const countBefore = before.length;

            // Re-open utils.inc with identical content (triggers reindex)
            const utilsContent = fs.readFileSync(path.join(FIXTURES, 'utils.inc'), 'utf-8');
            client.openDocument(fileUri('utils.inc'), utilsContent);
            await new Promise(r => setTimeout(r, 200));

            // Count should be the same — no symbols lost
            const after = await client.completion(fileUri('main.asm'), 0, 0) as any[];
            expect(after.length).toBe(countBefore);
        }, 15000);
    });
});
