import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class PHPCSFixerIntegration implements vscode.DocumentFormattingEditProvider {
    private phpCsFixerPath: string | null = null;
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.detectPHPCSFixer();
    }

    private async detectPHPCSFixer(): Promise<void> {
        // Try vendor/bin/php-cs-fixer
        const vendorPath = path.join(this.workspaceRoot, 'vendor', 'bin', 'php-cs-fixer');
        if (await fs.pathExists(vendorPath)) {
            this.phpCsFixerPath = path.relative(this.workspaceRoot, vendorPath);
            this.outputChannel.appendLine(`[PHP-CS-Fixer] Found at: ${vendorPath}`);
            return;
        }

        // Try global php-cs-fixer
        try {
            await execAsync('which php-cs-fixer');
            this.phpCsFixerPath = 'php-cs-fixer';
            this.outputChannel.appendLine(`[PHP-CS-Fixer] Using global installation`);
        } catch (e) {
            this.outputChannel.appendLine(`[PHP-CS-Fixer] Not found. Install: composer require --dev friendsofphp/php-cs-fixer`);
        }
    }

    public isAvailable(): boolean {
        return this.phpCsFixerPath !== null;
    }

    private getConfig(): any {
        return vscode.workspace.getConfiguration('phpRefactorTools.phpCsFixer');
    }

    public async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options: vscode.FormattingOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.TextEdit[]> {
        const config = this.getConfig();
        if (!config.get('enabled', true)) {
            return [];
        }

        if (!this.phpCsFixerPath) {
            vscode.window.showWarningMessage('PHP-CS-Fixer not found. Install: composer require --dev friendsofphp/php-cs-fixer');
            return [];
        }

        try {
            const phpConfig = vscode.workspace.getConfiguration('php');
            let phpExe = phpConfig.get<string>('validate.executablePath') || 'php';

            // Resolve relative path for executable (e.g. ./php)
            if (phpExe.startsWith('./') || phpExe.startsWith('.\\')) {
                phpExe = path.resolve(this.workspaceRoot, phpExe);
            }

            const filePath = document.uri.fsPath;
            const configFile = config.get('configFile', '.php-cs-fixer.php');

            let command = `${phpExe} ${this.phpCsFixerPath} fix`;

            if (configFile && await fs.pathExists(path.join(this.workspaceRoot, configFile))) {
                const relativeConfigPath = path.relative(this.workspaceRoot, path.join(this.workspaceRoot, configFile));
                command += ` --config=${relativeConfigPath}`;
            }
            // Use relative path for compatibility with container wrappers
            const relativePath = path.relative(this.workspaceRoot, filePath);
            command += ` "${relativePath}"`;

            this.outputChannel.appendLine(`[PHP-CS-Fixer] Running: ${command}`);

            await execAsync(command, {
                cwd: this.workspaceRoot,
                timeout: 30000
            });

            // Read the fixed file content
            const fixedContent = await fs.readFile(filePath, 'utf-8');

            // Return a single edit that replaces the entire document
            const firstLine = document.lineAt(0);
            const lastLine = document.lineAt(document.lineCount - 1);
            const range = new vscode.Range(firstLine.range.start, lastLine.range.end);

            this.outputChannel.appendLine(`[PHP-CS-Fixer] File formatted successfully`);

            return [vscode.TextEdit.replace(range, fixedContent)];

        } catch (error: any) {
            this.outputChannel.appendLine(`[PHP-CS-Fixer] Error: ${error.message}`);
            vscode.window.showErrorMessage(`PHP-CS-Fixer failed: ${error.message}`);
            return [];
        }
    }

    public async fixFile(filePath: string): Promise<void> {
        const config = this.getConfig();
        if (!config.get('enabled', true)) {
            return;
        }

        if (!this.phpCsFixerPath) {
            vscode.window.showWarningMessage('PHP-CS-Fixer not found.');
            return;
        }

        try {
            const configFile = config.get('configFile', '.php-cs-fixer.php');

            let command = `${this.phpCsFixerPath} fix`;

            if (configFile && await fs.pathExists(path.join(this.workspaceRoot, configFile))) {
                command += ` --config=${path.join(this.workspaceRoot, configFile)}`;
            }

            // Use relative path for compatibility with container wrappers
            const relativePath = path.relative(this.workspaceRoot, filePath);
            command += ` "${relativePath}"`;

            this.outputChannel.appendLine(`[PHP-CS-Fixer] Running: ${command}`);

            await execAsync(command, {
                cwd: this.workspaceRoot,
                timeout: 30000
            });

            this.outputChannel.appendLine(`[PHP-CS-Fixer] File fixed successfully`);

        } catch (error: any) {
            if (error.message && (error.message.includes('No such file or directory') || error.code === 127)) {
                this.outputChannel.appendLine(`[PHP-CS-Fixer] CRITICAL: PHP executable not found. Disabling Fixer for this session.`);
                this.phpCsFixerPath = null;
            } else {
                this.outputChannel.appendLine(`[PHP-CS-Fixer] Error: ${error.message}`);
            }
        }
    }

    public dispose(): void {
        // No resources to dispose
    }
}
