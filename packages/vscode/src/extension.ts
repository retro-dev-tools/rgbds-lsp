import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
    MessageType,
    State,
} from 'vscode-languageclient/node';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import * as fs from 'fs';
import * as path from 'path';

let client: LanguageClient | undefined;

// ─── Makefile parsing ─────────────────────────────────────────

interface MakefileInfo {
    targets: string[];
    buildTarget: string | null;
    romPath: string | null;
    symPath: string | null;
}

function parseMakefile(content: string, workspaceRoot: string): MakefileInfo {
    const targets: string[] = [];
    const variables = new Map<string, string>();
    let romPath: string | null = null;
    let symPath: string | null = null;

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.replace(/#.*$/, '').trim();
        if (!trimmed) continue;

        // Variable assignment: VAR = value, VAR := value, VAR ?= value
        const varMatch = trimmed.match(/^(\w+)\s*[:?]?=\s*(.+)$/);
        if (varMatch) {
            variables.set(varMatch[1], varMatch[2].trim());
            continue;
        }

        // Target: name: (skip pattern rules with %, skip .PHONY)
        const targetMatch = trimmed.match(/^([\w][\w.-]*)\s*:/);
        if (targetMatch && !trimmed.includes('%') && !trimmed.startsWith('.')) {
            targets.push(targetMatch[1]);
        }
    }

    function resolve(value: string): string {
        return value.replace(/\$[({](\w+)[)}]/g, (_, name) => variables.get(name) || '');
    }

    // Look for ROM path: ROM variable first, then scan all values
    const romVar = variables.get('ROM');
    if (romVar) {
        const resolved = resolve(romVar);
        if (/\.(gb|gbc)$/i.test(resolved)) {
            romPath = path.resolve(workspaceRoot, resolved);
        }
    }
    if (!romPath) {
        for (const [, value] of variables) {
            const resolved = resolve(value);
            if (/\.(gb|gbc)$/i.test(resolved)) {
                romPath = path.resolve(workspaceRoot, resolved);
                break;
            }
        }
    }

    // Look for SYM path: SYM variable first, then scan all values
    const symVar = variables.get('SYM');
    if (symVar) {
        const resolved = resolve(symVar);
        if (/\.sym$/i.test(resolved)) {
            symPath = path.resolve(workspaceRoot, resolved);
        }
    }
    if (!symPath) {
        for (const [, value] of variables) {
            const resolved = resolve(value);
            if (/\.sym$/i.test(resolved)) {
                symPath = path.resolve(workspaceRoot, resolved);
                break;
            }
        }
    }

    const preferred = ['all', 'build', 'rom'];
    const buildTarget = preferred.find(t => targets.includes(t)) || targets[0] || null;

    return { targets, buildTarget, romPath, symPath };
}

function findMakefile(workspaceRoot: string): string | null {
    for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
        const p = path.join(workspaceRoot, name);
        try {
            if (fs.statSync(p).isFile()) return p;
        } catch {}
    }
    return null;
}

function loadMakefileInfo(workspaceRoot: string): MakefileInfo | null {
    const makefilePath = findMakefile(workspaceRoot);
    if (!makefilePath) return null;
    try {
        return parseMakefile(fs.readFileSync(makefilePath, 'utf-8'), workspaceRoot);
    } catch {
        return null;
    }
}

// ─── Server discovery ─────────────────────────────────────────

async function findServer(): Promise<string | null> {
    const configPath = vscode.workspace.getConfiguration('rgbds').get<string>('serverPath');
    if (configPath) return configPath;

    try {
        const { stdout } = await execAsync('npm root -g', { timeout: 5000 });
        return require.resolve('@retro-dev/rgbds-language-server', { paths: [stdout.trim()] });
    } catch {}

    return null;
}

// ─── Extension lifecycle ──────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let makefileInfo: MakefileInfo | null = null;

    // ─── Language status item (always created) ────────────────

    const buildStatus = vscode.languages.createLanguageStatusItem('rgbds.build', { language: 'rgbds' });
    buildStatus.name = 'RGBDS Build';
    buildStatus.command = { command: 'rgbds.configureBuild', title: 'Configure' };
    context.subscriptions.push(buildStatus);

    function updateStatusItem() {
        const cfg = vscode.workspace.getConfiguration('rgbds');
        const buildCmd = cfg.get<string>('buildCommand');
        const rom = cfg.get<string>('romPath');
        const bytesEnabled = cfg.get<boolean>('assembledBytes.enabled', false);

        if (buildCmd) {
            buildStatus.text = `$(tools) ${buildCmd}`;
            const details: string[] = [];
            if (rom) details.push(`ROM: ${path.basename(rom)}`);
            if (bytesEnabled) details.push('Byte decorations on');
            buildStatus.detail = details.join(' · ') || 'Click to configure';
        } else {
            buildStatus.text = '$(tools) No build';
            buildStatus.detail = 'Click to configure';
        }
    }

    // ─── Configure build command ──────────────────────────────

    const configureCmd = vscode.commands.registerCommand('rgbds.configureBuild', async () => {
        const cfg = vscode.workspace.getConfiguration('rgbds');
        const currentBuild = cfg.get<string>('buildCommand') || '';
        const currentRom = cfg.get<string>('romPath') || '';
        const currentSym = cfg.get<string>('symPath') || '';
        const bytesEnabled = cfg.get<boolean>('assembledBytes.enabled', false);

        if (workspaceRoot) {
            makefileInfo = loadMakefileInfo(workspaceRoot);
        }

        const items: vscode.QuickPickItem[] = [
            {
                label: '$(terminal) Build Target',
                description: currentBuild || 'not set',
                detail: makefileInfo?.targets.length
                    ? `Detected targets: ${makefileInfo.targets.join(', ')}`
                    : 'No Makefile found',
            },
            {
                label: '$(file-binary) ROM File',
                description: currentRom ? path.basename(currentRom) : 'auto-detect',
            },
            {
                label: '$(symbol-file) Symbol File',
                description: currentSym ? path.basename(currentSym) : 'auto-detect',
            },
            {
                label: `$(${bytesEnabled ? 'check' : 'circle-outline'}) Assembled Bytes`,
                description: bytesEnabled ? 'Enabled' : 'Disabled',
                detail: 'Show assembled hex bytes next to source lines (experimental)',
            },
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: 'RGBDS Build Configuration',
            placeHolder: 'Select a setting to configure',
        });

        if (!picked) return;

        if (picked.label.includes('Build Target')) {
            await configureBuildTarget(cfg, makefileInfo);
        } else if (picked.label.includes('ROM File')) {
            await configureFilePath(cfg, 'romPath', 'Select ROM file', { 'ROM files': ['gb', 'gbc'] });
        } else if (picked.label.includes('Symbol File')) {
            await configureFilePath(cfg, 'symPath', 'Select symbol file', { 'Symbol files': ['sym'] });
        } else if (picked.label.includes('Assembled Bytes')) {
            await cfg.update('assembledBytes.enabled', !bytesEnabled, vscode.ConfigurationTarget.Workspace);
        }

        updateStatusItem();
    });

    context.subscriptions.push(configureCmd);

    // ─── Makefile auto-detection + prompt ─────────────────────

    if (workspaceRoot) {
        makefileInfo = loadMakefileInfo(workspaceRoot);
        if (makefileInfo?.buildTarget) {
            const cfg = vscode.workspace.getConfiguration('rgbds');
            const alreadyConfigured = !!cfg.get<string>('buildCommand');

            if (!alreadyConfigured) {
                // Prompt user like C++ IntelliSense does
                const buildCmd = makefileInfo.buildTarget === 'all' ? 'make' : `make ${makefileInfo.buildTarget}`;
                vscode.window.showInformationMessage(
                    `Would you like to configure RGBDS build from your Makefile? (${buildCmd})`,
                    'Yes', 'No',
                ).then(choice => {
                    if (choice === 'Yes') {
                        autoSetFromMakefile(makefileInfo!);
                        updateStatusItem();
                    }
                });
            }
        }
    }

    updateStatusItem();

    // ─── Clear cache command ──────────────────────────────────

    const clearCacheCmd = vscode.commands.registerCommand('rgbds.clearCache', async () => {
        const cacheDir = path.join(require('os').homedir(), '.rgbds-lsp', 'cache');
        try {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            vscode.window.showInformationMessage('RGBDS index cache cleared. Reloading...');
            // Restart the extension host to force full re-index
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to clear cache: ${e.message}`);
        }
    });
    context.subscriptions.push(clearCacheCmd);

    // ─── Config & Makefile watchers ───────────────────────────

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('rgbds')) {
                updateStatusItem();
                if (client?.state === State.Running) {
                    client.sendNotification('workspace/didChangeConfiguration', {
                        settings: { rgbds: vscode.workspace.getConfiguration('rgbds') },
                    });
                }
            }
        }),
    );

    if (workspaceRoot) {
        const makefileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '{Makefile,makefile,GNUmakefile}'),
        );
        makefileWatcher.onDidChange(() => {
            makefileInfo = loadMakefileInfo(workspaceRoot);
            updateStatusItem();
        });
        makefileWatcher.onDidDelete(() => {
            makefileInfo = null;
            updateStatusItem();
        });
        makefileWatcher.onDidCreate(() => {
            makefileInfo = loadMakefileInfo(workspaceRoot);
            if (makefileInfo?.buildTarget) {
                const cfg = vscode.workspace.getConfiguration('rgbds');
                if (!cfg.get<string>('buildCommand')) {
                    const buildCmd = makefileInfo.buildTarget === 'all' ? 'make' : `make ${makefileInfo.buildTarget}`;
                    vscode.window.showInformationMessage(
                        `Would you like to configure RGBDS build from your Makefile? (${buildCmd})`,
                        'Yes', 'No',
                    ).then(choice => {
                        if (choice === 'Yes') {
                            autoSetFromMakefile(makefileInfo!);
                            updateStatusItem();
                        }
                    });
                }
            }
        });
        context.subscriptions.push(makefileWatcher);
    }

    // ─── Language server ──────────────────────────────────────

    const serverModule = await findServer();

    if (!serverModule) {
        vscode.window.showErrorMessage(
            'RGBDS language server not found. Install it with: npm install -g @retro-dev/rgbds-language-server',
            'Install now',
        ).then(choice => {
            if (choice === 'Install now') {
                const terminal = vscode.window.createTerminal('RGBDS LSP Install');
                terminal.sendText('npm install -g @retro-dev/rgbds-language-server');
                terminal.show();
            }
        });
        return;
    }

    const config = vscode.workspace.getConfiguration('rgbds');

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc },
    };

    const outputChannel = vscode.window.createOutputChannel('RGBDS LSP', { log: true });
    context.subscriptions.push(outputChannel);

    const logOutputChannel = outputChannel as vscode.LogOutputChannel;

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'rgbds' },
            { scheme: 'untitled', language: 'rgbds' },
        ],
        outputChannel,
        middleware: {
            window: {
                logMessage(type, message, next) {
                    // Write directly to LogOutputChannel to avoid client's [Info - time] prefix
                    switch (type) {
                        case MessageType.Error: logOutputChannel.error(message); break;
                        case MessageType.Warning: logOutputChannel.warn(message); break;
                        case MessageType.Log: logOutputChannel.debug(message); break;
                        default: logOutputChannel.info(message); break;
                    }
                },
            },
        },
        synchronize: {
            fileEvents: [
                vscode.workspace.createFileSystemWatcher('**/*.{asm,inc}'),
                vscode.workspace.createFileSystemWatcher('**/*.{gb,gbc,sym}'),
            ],
        },
        initializationOptions: {
            buildCommand: config.get<string>('buildCommand') || undefined,
            romPath: config.get<string>('romPath') || undefined,
            symPath: config.get<string>('symPath') || undefined,
            validateCommentBytes: config.get<boolean>('validateCommentBytes', false),
            assembledBytes: {
                enabled: config.get<boolean>('assembledBytes.enabled', false),
                maxBytesPerLine: config.get<number>('assembledBytes.maxBytesPerLine', 8),
            },
            inlayHints: {
                constantValues: config.get<boolean>('inlayHints.constantValues', true),
                macroParameters: config.get<boolean>('inlayHints.macroParameters', false),
            },
        },
    };

    client = new LanguageClient(
        'rgbds-lsp',
        'RGBDS Language Server',
        serverOptions,
        clientOptions,
    );

    client.start();
    context.subscriptions.push(client);

    // ─── Assembled bytes decorations ─────────────────────────
    setupByteDecorations(context, config);
}

// ─── Assembled Bytes Decorations ──────────────────────────────

interface AssembledBytesEntry {
    line: number;
    short: string;
    full: string;
    hasComment: boolean;
}

function setupByteDecorations(
    context: vscode.ExtensionContext,
    config: vscode.WorkspaceConfiguration,
) {
    const decorationType = vscode.window.createTextEditorDecorationType({
        after: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'normal',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    context.subscriptions.push(decorationType);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function isEnabled(): boolean {
        return vscode.workspace.getConfiguration('rgbds').get<boolean>('assembledBytes.enabled', false);
    }

    async function updateDecorations(editor: vscode.TextEditor) {
        if (!isEnabled() || editor.document.languageId !== 'rgbds') {
            editor.setDecorations(decorationType, []);
            return;
        }

        if (!client || client.state !== State.Running) {
            editor.setDecorations(decorationType, []);
            return;
        }

        const alignColumn = vscode.workspace.getConfiguration('rgbds').get<number>('assembledBytes.alignColumn', 60);
        const visibleRanges = editor.visibleRanges;
        if (visibleRanges.length === 0) return;

        const startLine = visibleRanges[0].start.line;
        const endLine = visibleRanges[visibleRanges.length - 1].end.line;

        try {
            const result = await client.sendRequest<{ lines: AssembledBytesEntry[] }>('rgbds/assembledBytes', {
                uri: editor.document.uri.toString(),
                startLine,
                endLine,
            });

            const decorations: vscode.DecorationOptions[] = [];
            for (const entry of result.lines) {
                if (entry.hasComment) continue;

                const lineText = editor.document.lineAt(entry.line).text;
                const lineLen = lineText.length;
                const padding = Math.max(2, alignColumn - lineLen);
                const contentText = ' '.repeat(padding) + entry.short;

                decorations.push({
                    range: new vscode.Range(entry.line, lineLen, entry.line, lineLen),
                    hoverMessage: entry.full !== entry.short ? new vscode.MarkdownString('`' + entry.full + '`') : undefined,
                    renderOptions: {
                        after: { contentText },
                    },
                });
            }

            editor.setDecorations(decorationType, decorations);
        } catch {
            // Server not ready or request failed — clear decorations
            editor.setDecorations(decorationType, []);
        }
    }

    function scheduleUpdate(editor: vscode.TextEditor | undefined) {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (!editor) return;
        debounceTimer = setTimeout(() => updateDecorations(editor), 300);
    }

    // Event hooks
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) scheduleUpdate(editor);
        }),
        vscode.window.onDidChangeTextEditorVisibleRanges(e => {
            scheduleUpdate(e.textEditor);
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === e.document) {
                scheduleUpdate(editor);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('rgbds.assembledBytes')) {
                const editor = vscode.window.activeTextEditor;
                if (editor) updateDecorations(editor);
            }
        }),
    );

    // Initial update for active editor — trigger when client becomes ready
    client?.onDidChangeState(e => {
        if (e.newState === State.Running && vscode.window.activeTextEditor) {
            updateDecorations(vscode.window.activeTextEditor);
        }
    });
}

// ─── Helpers ──────────────────────────────────────────────────

async function configureBuildTarget(
    cfg: vscode.WorkspaceConfiguration,
    makefileInfo: MakefileInfo | null,
) {
    const items: vscode.QuickPickItem[] = [];

    if (makefileInfo?.targets.length) {
        for (const target of makefileInfo.targets) {
            const cmd = target === 'all' ? 'make' : `make ${target}`;
            items.push({
                label: target,
                description: cmd,
                detail: target === makefileInfo.buildTarget ? 'Recommended' : undefined,
            });
        }
    }

    items.push({
        label: '$(edit) Custom command...',
        description: 'Enter a custom build command',
    });

    items.push({
        label: '$(close) Clear',
        description: 'Remove build command',
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Select Build Target',
        placeHolder: 'Choose a Makefile target or enter a custom command',
    });

    if (!picked) return;

    if (picked.label === '$(edit) Custom command...') {
        const cmd = await vscode.window.showInputBox({
            title: 'Build Command',
            prompt: 'Shell command to build the ROM (e.g., make, make build)',
            value: cfg.get<string>('buildCommand') || 'make',
        });
        if (cmd !== undefined) {
            await cfg.update('buildCommand', cmd || undefined, vscode.ConfigurationTarget.Workspace);
        }
    } else if (picked.label === '$(close) Clear') {
        await cfg.update('buildCommand', undefined, vscode.ConfigurationTarget.Workspace);
    } else {
        const cmd = picked.label === 'all' ? 'make' : `make ${picked.label}`;
        await cfg.update('buildCommand', cmd, vscode.ConfigurationTarget.Workspace);
    }
}

async function configureFilePath(
    cfg: vscode.WorkspaceConfiguration,
    settingKey: string,
    title: string,
    filters: Record<string, string[]>,
) {
    const items: vscode.QuickPickItem[] = [
        { label: '$(file) Browse...', description: 'Select a file' },
        { label: '$(search) Auto-detect', description: 'Let the server find it automatically' },
    ];

    const picked = await vscode.window.showQuickPick(items, { title });
    if (!picked) return;

    if (picked.label.includes('Browse')) {
        const uris = await vscode.window.showOpenDialog({
            title,
            filters,
            canSelectMany: false,
        });
        if (uris?.[0]) {
            await cfg.update(settingKey, uris[0].fsPath, vscode.ConfigurationTarget.Workspace);
        }
    } else {
        await cfg.update(settingKey, undefined, vscode.ConfigurationTarget.Workspace);
    }
}

function autoSetFromMakefile(info: MakefileInfo) {
    const cfg = vscode.workspace.getConfiguration('rgbds');

    if (!cfg.get<string>('buildCommand') && info.buildTarget) {
        const cmd = info.buildTarget === 'all' ? 'make' : `make ${info.buildTarget}`;
        cfg.update('buildCommand', cmd, vscode.ConfigurationTarget.Workspace);
    }
    if (!cfg.get<string>('romPath') && info.romPath) {
        cfg.update('romPath', info.romPath, vscode.ConfigurationTarget.Workspace);
    }
    if (!cfg.get<string>('symPath') && info.symPath) {
        cfg.update('symPath', info.symPath, vscode.ConfigurationTarget.Workspace);
    }
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) return undefined;
    return client.stop();
}
