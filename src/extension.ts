import * as vscode from 'vscode';
import { handleFileRename } from './refactor';
import { Indexer } from './indexer';
import { PhpDefinitionProvider } from './definitionProvider';
import { PhpRenameProvider } from './renameProvider';
import { PhpDocProvider } from './docProvider';
import { createPhpFile } from './createFileCommand';
import { moveFileWithRefactor } from './moveFileCommand';
import { createRefactorEdit } from './refactorPreview';
import { PhpReferenceProvider } from './referenceProvider';
import { PhpImplementationProvider } from './implementationProvider';
import { PhpImportDiagnostics } from './importDiagnostics';
import { PhpImportCodeActions } from './importCodeActions';
import { PHPStanIntegration } from './phpstanIntegration';
import { PHPCSIntegration } from './phpcsIntegration';
import { PHPCSFixerIntegration } from './phpCsFixerIntegration';
import { initializeWorkspaceConfig } from './workspaceConfig';
import { PhpRefactorCodeActionProvider } from './refactorProvider';
import { renameClassCommand } from './renameClassCommand';
import { renameMethodCommand } from './renameMethodCommand';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "vs-php-refactor-tools" is now active!');
    vscode.window.showInformationMessage('PHP Refactor Tools Active');

    const outputChannel = vscode.window.createOutputChannel("PHP Refactor Tools");
    const indexer = new Indexer(outputChannel);

    const config = vscode.workspace.getConfiguration('phpRefactorTools');

    // Initialize Import Diagnostics
    const importDiagnostics = new PhpImportDiagnostics(indexer);

    // Initialize PHPStan Integration
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const phpstan = new PHPStanIntegration(workspaceRoot, outputChannel);

    // Initialize PHPCS Integration
    const phpcs = new PHPCSIntegration(workspaceRoot, outputChannel);

    // Initialize PHP-CS-Fixer Integration
    const phpCsFixer = new PHPCSFixerIntegration(workspaceRoot, outputChannel);

    // Start background indexing
    outputChannel.appendLine('[Extension] Starting workspace scan...');
    indexer.scanWorkspace()
        .then(() => {
            outputChannel.appendLine('[Extension] Workspace scan completed successfully.');
            // Update diagnostics for all open PHP files after indexing completes
            vscode.workspace.textDocuments.forEach(doc => {
                if (doc.languageId === 'php') {
                    importDiagnostics.updateDiagnostics(doc);
                }
            });
        })
        .catch(err => {
            const msg = `Failed to index workspace: ${err.message}`;
            outputChannel.appendLine(`[Extension] ERROR: ${msg}`);
            console.error(err);
            vscode.window.showErrorMessage(`PHP Refactor Tools: Indexing failed on startup. check 'PHP Refactor Tools' output for details.`);
        });

    // Keep index updated and run tools on save
    let phpstanTimeout: NodeJS.Timeout | undefined;
    let phpcsTimeout: NodeJS.Timeout | undefined;
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async doc => {
        if (doc.languageId === 'php') {
            indexer.scanFile(doc.uri);
            importDiagnostics.updateDiagnostics(doc);

            // Run PHPStan with debouncing
            // Run PHPStan with debouncing
            if (config.get('phpstan.enabled', false) && phpstan.isAvailable()) {
                if (phpstanTimeout) {
                    clearTimeout(phpstanTimeout);
                }
                phpstanTimeout = setTimeout(async () => {
                    await phpstan.analyzeFile(doc.uri.fsPath);
                }, 1000);
            }

            // Run PHPCS with debouncing
            // Run PHPCS with debouncing
            if (config.get('phpcs.enabled', false) && phpcs.isAvailable()) {
                if (phpcsTimeout) {
                    clearTimeout(phpcsTimeout);
                }
                phpcsTimeout = setTimeout(async () => {
                    await phpcs.analyzeFile(doc.uri.fsPath);
                }, 1000);
            }

            // Run PHP-CS-Fixer on save if enabled
            if (config.get('phpCsFixer.enabled', false) && config.get('phpCsFixer.onSave', false) && phpCsFixer.isAvailable()) {
                await phpCsFixer.fixFile(doc.uri.fsPath);
            }
        }
    }));

    // Update diagnostics on text change (debounced)
    let diagnosticTimeout: NodeJS.Timeout | undefined;
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'php') {
            if (diagnosticTimeout) {
                clearTimeout(diagnosticTimeout);
            }
            diagnosticTimeout = setTimeout(() => {
                importDiagnostics.updateDiagnostics(e.document);
            }, 500);
        }
    }));

    // Update diagnostics when opening a file
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId === 'php') {
            importDiagnostics.updateDiagnostics(doc);
        }
    }));

    // Watch for new PHP files
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.php');
    context.subscriptions.push(watcher);

    watcher.onDidCreate(uri => {
        outputChannel.appendLine(`[Watcher] New file detected: ${uri.fsPath}`);
        indexer.scanFile(uri);
    });

    watcher.onDidDelete(uri => {
        outputChannel.appendLine(`[Watcher] File deleted: ${uri.fsPath}`);
        indexer.removeFile(uri);
    });

    watcher.onDidChange(uri => {
        outputChannel.appendLine(`[Watcher] File changed: ${uri.fsPath}`);
        indexer.scanFile(uri);
    });

    // Clear diagnostics when closing a file
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.languageId === 'php') {
            importDiagnostics.clear(doc);
        }
    }));

    // Dispose diagnostics on deactivation
    context.subscriptions.push(importDiagnostics.getDiagnosticCollection());

    // Register Refactoring Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.renameClass', renameClassCommand)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.renameMethod', renameMethodCommand(indexer, outputChannel))
    );

    // Wire rename event (only if auto-refactor is enabled)
    // 1. onWillRenameFiles: Participate in the rename with a WorkspaceEdit (triggers Preview)
    context.subscriptions.push(vscode.workspace.onWillRenameFiles((e) => {
        if (!config.get('refactor.autoMoveFile', false)) {
            // If explicit auto-move is OFF, we assume the user might want the preview behavior 
            // naturally provided by VS Code when we return edits.
            // If checking a 'alwaysPreview' flag, we can decide here.
            // Currently, we'll ALWAYS produce the edit so VS Code handles the preview 
            // unless the file type is ignored.
        }

        outputChannel.appendLine(`[Extension] onWillRenameFiles: ${e.files.length} files`);

        const promise = async () => {
            const edit = new vscode.WorkspaceEdit();

            for (const { oldUri, newUri } of e.files) {
                // Generate edits for each moved file
                const fileEdit = await createRefactorEdit(oldUri, newUri, indexer, outputChannel);
                if (fileEdit) {
                    // Merge edits into the main WorkspaceEdit
                    for (const [uri, edits] of fileEdit.entries()) {
                        edit.set(uri, [...(edit.get(uri) || []), ...edits]);
                    }
                }
            }
            return edit;
        };

        // This is what triggers the VS Code Refactor Preview UI (if edits are returned)
        e.waitUntil(promise());
    }));

    // 2. onDidRenameFiles: Just update our internal Index (the file is already moved)
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(async (e) => {
        // Just update the indexer, do NOT refactor code here (already done in onWillRenameFiles)
        for (const { oldUri, newUri } of e.files) {
            if (oldUri.fsPath.endsWith('.php')) {
                await indexer.removeFile(oldUri);
            }
            if (newUri.fsPath.endsWith('.php')) {
                await indexer.scanFile(newUri);
            }
        }
    }));

    if (config.get('navigation.enabled', false)) {
        context.subscriptions.push(
            vscode.languages.registerDefinitionProvider(
                { scheme: 'file', language: 'php' },
                new PhpDefinitionProvider(indexer, outputChannel)
            )
        );
    }

    // Register Rename Provider
    if (config.get('navigation.enabled', false)) {
        context.subscriptions.push(
            vscode.languages.registerRenameProvider(
                { scheme: 'file', language: 'php' },
                new PhpRenameProvider(indexer)
            )
        );
    }

    // Register PHPDoc Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', language: 'php' },
            new PhpDocProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] }
        )
    );

    // Register Import Quick Fix Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', language: 'php' },
            new PhpImportCodeActions(indexer),
            { providedCodeActionKinds: PhpImportCodeActions.providedCodeActionKinds }
        )
    );

    // Register Class Rename Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { scheme: 'file', language: 'php' },
            new PhpRefactorCodeActionProvider(),
            { providedCodeActionKinds: PhpRefactorCodeActionProvider.providedCodeActionKinds }
        )
    );



    // Register Reference Provider
    if (config.get('navigation.enabled', false)) {
        context.subscriptions.push(
            vscode.languages.registerReferenceProvider(
                { scheme: 'file', language: 'php' },
                new PhpReferenceProvider(indexer, outputChannel)
            )
        );
    }

    // Register Implementation Provider
    if (config.get('navigation.enabled', false)) {
        context.subscriptions.push(
            vscode.languages.registerImplementationProvider(
                { scheme: 'file', language: 'php' },
                new PhpImplementationProvider(indexer, outputChannel)
            )
        );
    }

    // Register Create File Wizard
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.createPhpFile', async (uri: vscode.Uri) => {
            await createPhpFile(uri, indexer);
        })
    );

    // Register Manual Move File Refactor Command
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.moveFileRefactor', async (uri: vscode.Uri) => {
            await moveFileWithRefactor(uri, indexer, outputChannel);
        })
    );

    // Register PHP-CS-Fixer as Document Formatter
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { scheme: 'file', language: 'php' },
            phpCsFixer
        )
    );

    // Register PHPStan Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.runPhpstan', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'php') {
                await phpstan.analyzeFile(editor.document.uri.fsPath);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.runPhpstanWorkspace', async () => {
            await phpstan.analyzeWorkspace();
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand('vs-php-refactor-tools.checkStatus', async () => {
        outputChannel.clear();
        outputChannel.appendLine('--- PHP Refactor Tools Integration Status ---');

        // Indexer
        const stats = indexer.getStats();
        outputChannel.appendLine(`[Indexer] Files: ${stats.files}, Symbols: ${stats.symbols}`);

        // PHPStan
        outputChannel.appendLine(`[PHPStan] Available: ${phpstan.isAvailable() ? 'YES' : 'NO'}`);
        if (!phpstan.isAvailable()) {
            outputChannel.appendLine(`   -> Hint: Install via 'composer require --dev phpstan/phpstan' or ensure 'php' is in PATH`);
        }

        // PHPCS
        outputChannel.appendLine(`[PHPCS] Available: ${phpcs.isAvailable() ? 'YES' : 'NO'}`);
        if (!phpcs.isAvailable()) {
            outputChannel.appendLine(`   -> Hint: Install via 'composer require --dev squizlabs/php_codesniffer'`);
        }

        // PHP-CS-Fixer
        outputChannel.appendLine(`[PHP-CS-Fixer] Available: ${phpCsFixer.isAvailable() ? 'YES' : 'NO'}`);
        if (!phpCsFixer.isAvailable()) {
            outputChannel.appendLine(`   -> Hint: Install via 'composer require --dev friendsofphp/php-cs-fixer'`);
        }

        outputChannel.appendLine('-----------------------------------');
        outputChannel.show();
    }));

    // Register PHPCS Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.runPhpcs', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'php') {
                await phpcs.analyzeFile(editor.document.uri.fsPath);
            }
        })
    );

    // Register PHP-CS-Fixer Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.runPhpCsFixer', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'php') {
                await phpCsFixer.fixFile(editor.document.uri.fsPath);
                vscode.window.showInformationMessage('PHP-CS-Fixer: File fixed');
            }
        })
    );

    // Register Workspace Config Command
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.initWorkspaceConfig', async () => {
            await initializeWorkspaceConfig();
        })
    );

    // Register Rebuild Index Command
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.rebuildIndex', async () => {
            vscode.window.showInformationMessage('Rebuilding PHP index...');
            await indexer.rebuildIndex();
            vscode.window.showInformationMessage('Index rebuilt successfully!');
        })
    );

    // Register Inspection Command
    context.subscriptions.push(
        vscode.commands.registerCommand('vs-php-refactor-tools.inspectIndex', async () => {
            const query = await vscode.window.showInputBox({
                placeHolder: 'Enter class name (e.g. Request)',
                prompt: 'Search for symbol in PHP Refactor Tools index'
            });

            if (!query) return;

            const definitions = indexer.getDefinitions(query);
            outputChannel.clear();
            outputChannel.show();
            outputChannel.appendLine(`--- Index Inspection: ${query} ---`);

            if (definitions.length === 0) {
                outputChannel.appendLine('❌ Symbol not found in index.');
                outputChannel.appendLine('Possible reasons:');
                outputChannel.appendLine('- Vendor indexing is disabled (check settings)');
                outputChannel.appendLine('- Index has not finished building');
                outputChannel.appendLine('- Parse error in source file');
                return;
            }

            outputChannel.appendLine(`✅ Found ${definitions.length} definitions:`);
            definitions.forEach((def, i) => {
                outputChannel.appendLine(`\n[${i + 1}] ${def.name}`);
                outputChannel.appendLine(`    FQN:  ${def.fqn || '⚠️ MISSING'}`);
                outputChannel.appendLine(`    Path: ${def.path}`);
                outputChannel.appendLine(`    Kind: ${def.kind}`);
            });
        })
    );

    // Dispose diagnostic collections on deactivation
    context.subscriptions.push(phpstan.getDiagnosticCollection());
    context.subscriptions.push(phpcs.getDiagnosticCollection());
}

export function deactivate() { }
