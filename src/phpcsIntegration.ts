import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface PHPCSMessage {
    message: string;
    source: string;
    severity: number; // 5 = error, < 5 = warning
    type: string; // ERROR or WARNING
    line: number;
    column: number;
    fixable: boolean;
}

interface PHPCSFile {
    errors: number;
    warnings: number;
    messages: PHPCSMessage[];
}

interface PHPCSOutput {
    totals: {
        errors: number;
        warnings: number;
        fixable: number;
    };
    files: {
        [filePath: string]: PHPCSFile;
    };
}

export class PHPCSIntegration {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private phpcsPath: string | null = null;
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('phpcs');
        this.detectPHPCS();
    }

    private async detectPHPCS(): Promise<void> {
        // Try vendor/bin/phpcs
        const vendorPath = path.join(this.workspaceRoot, 'vendor', 'bin', 'phpcs');
        if (await fs.pathExists(vendorPath)) {
            this.phpcsPath = path.relative(this.workspaceRoot, vendorPath);
            this.outputChannel.appendLine(`[PHPCS] Found at: ${vendorPath}`);
            return;
        }

        // Try global phpcs
        try {
            await execAsync('which phpcs');
            this.phpcsPath = 'phpcs';
            this.outputChannel.appendLine(`[PHPCS] Using global installation`);
        } catch (e) {
            this.outputChannel.appendLine(`[PHPCS] Not found. Install: composer require --dev squizlabs/php_codesniffer`);
        }
    }

    public isAvailable(): boolean {
        return this.phpcsPath !== null;
    }

    private getConfig(): any {
        return vscode.workspace.getConfiguration('phpRefactorTools.phpcs');
    }

    public async analyzeFile(filePath: string): Promise<void> {
        if (!this.phpcsPath) {
            return;
        }

        const config = this.getConfig();
        if (!config.get('enabled', true)) {
            return;
        }

        this.outputChannel.appendLine(`[PHPCS] Analyzing: ${filePath}`);
        const relativePath = path.relative(this.workspaceRoot, filePath);

        try {
            // Get PHP executable from config
            const phpConfig = vscode.workspace.getConfiguration('php');
            let phpExe = phpConfig.get<string>('validate.executablePath') || 'php';

            // Resolve relative path for executable (e.g. ./php)
            if (phpExe.startsWith('./') || phpExe.startsWith('.\\')) {
                phpExe = path.resolve(this.workspaceRoot, phpExe);
            }

            const standard = config.get('standard', 'PSR12');
            const configFile = config.get('configFile', '');

            // Construct command: phpExe tool path flags target
            let command = `${phpExe} ${this.phpcsPath} --report=json --standard=${standard}`;

            if (configFile && await fs.pathExists(path.join(this.workspaceRoot, configFile))) {
                // Config file path also needs to be relative if possible, or assume wrapper handles it
                // Using relative path for config file to be safe
                const relativeConfigPath = path.relative(this.workspaceRoot, path.join(this.workspaceRoot, configFile));
                command = `${phpExe} ${this.phpcsPath} --report=json --standard=${relativeConfigPath}`;
            }

            // Use relative path for compatibility with container wrappers
            command += ` "${relativePath}"`;

            const { stdout } = await execAsync(command, {
                cwd: this.workspaceRoot,
                timeout: 30000
            });

            this.outputChannel.appendLine(`[PHPCS Debug] Command: ${command}`);
            this.outputChannel.appendLine(`[PHPCS Debug] Raw Output: ${stdout}`);

            const result: PHPCSOutput = JSON.parse(stdout);
            const diagnostics: vscode.Diagnostic[] = [];

            // Fuzzy match file path (container path vs host path)
            // The JSON key might be different from our local filePath
            let fileData = result.files[filePath];
            if (!fileData) {
                const keys = Object.keys(result.files);
                this.outputChannel.appendLine(`[PHPCS Debug] Keys found in JSON: ${JSON.stringify(keys)}`);
                this.outputChannel.appendLine(`[PHPCS Debug] Looking for suffix: ${relativePath}`);

                // Try finding key that ends with the relative path
                const relativeKey = keys.find(key => key.endsWith(relativePath));
                if (relativeKey) {
                    fileData = result.files[relativeKey];
                    this.outputChannel.appendLine(`[PHPCS Debug] Match found (endsWith): ${relativeKey}`);
                } else {
                    // Try basename match
                    const targetBasename = path.basename(relativePath);
                    const basenameKey = keys.find(key => path.basename(key) === targetBasename);
                    if (basenameKey) {
                        fileData = result.files[basenameKey];
                        this.outputChannel.appendLine(`[PHPCS Debug] Match found (basename): ${basenameKey}`);
                    } else if (keys.length === 1) {
                        // Fallback: if there is only one file in result, use it
                        fileData = Object.values(result.files)[0];
                        this.outputChannel.appendLine(`[PHPCS Debug] Using single file fallback`);
                    } else {
                        this.outputChannel.appendLine(`[PHPCS Debug] No match found`);
                    }
                }
            }

            if (fileData && fileData.messages) {
                for (const msg of fileData.messages) {
                    const line = msg.line - 1;
                    const col = msg.column - 1;
                    const range = new vscode.Range(
                        new vscode.Position(line, col),
                        new vscode.Position(line, col + 10) // Approximate length
                    );

                    const severity = msg.type === 'ERROR'
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning;

                    const diagnostic = new vscode.Diagnostic(
                        range,
                        msg.message,
                        severity
                    );
                    diagnostic.source = `PHPCS (${msg.source})`;
                    diagnostic.code = msg.fixable ? 'fixable' : undefined;
                    diagnostics.push(diagnostic);
                }
            }

            this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
            this.outputChannel.appendLine(`[PHPCS] Found ${diagnostics.length} issues (${fileData?.errors || 0} errors, ${fileData?.warnings || 0} warnings)`);

        } catch (error: any) {
            // PHPCS exits with code 1 when violations found|
            if (error.stdout) {
                try {
                    this.outputChannel.appendLine(`[PHPCS Debug] Catch Error: ${error.stdout}`);
                    const result: PHPCSOutput = JSON.parse(error.stdout);
                    const diagnostics: vscode.Diagnostic[] = [];

                    // Fuzzy match file path (container path vs host path)
                    let fileData = result.files[filePath];
                    if (!fileData) {
                        const keys = Object.keys(result.files);
                        this.outputChannel.appendLine(`[PHPCS Debug Catch] Keys found in JSON: ${JSON.stringify(keys)}`);
                        this.outputChannel.appendLine(`[PHPCS Debug Catch] Looking for suffix: ${relativePath}`);

                        // Try finding key that ends with the relative path
                        const relativeKey = keys.find(key => key.endsWith(relativePath));
                        if (relativeKey) {
                            fileData = result.files[relativeKey];
                            this.outputChannel.appendLine(`[PHPCS Debug Catch] Match found (endsWith): ${relativeKey}`);
                        } else {
                            // Try basename match
                            const targetBasename = path.basename(relativePath);
                            const basenameKey = keys.find(key => path.basename(key) === targetBasename);
                            if (basenameKey) {
                                fileData = result.files[basenameKey];
                                this.outputChannel.appendLine(`[PHPCS Debug Catch] Match found (basename): ${basenameKey}`);
                            } else if (keys.length === 1) {
                                // Fallback: if there is only one file in result, use it
                                fileData = Object.values(result.files)[0];
                                this.outputChannel.appendLine(`[PHPCS Debug Catch] Using single file fallback`);
                            } else {
                                this.outputChannel.appendLine(`[PHPCS Debug Catch] No match found`);
                            }
                        }
                    }

                    if (fileData && fileData.messages) {
                        for (const msg of fileData.messages) {
                            const line = msg.line - 1;
                            const col = msg.column - 1;
                            const range = new vscode.Range(
                                new vscode.Position(line, col),
                                new vscode.Position(line, col + 10)
                            );

                            const severity = msg.type === 'ERROR'
                                ? vscode.DiagnosticSeverity.Error
                                : vscode.DiagnosticSeverity.Warning;

                            const diagnostic = new vscode.Diagnostic(
                                range,
                                msg.message,
                                severity
                            );
                            diagnostic.source = `PHPCS (${msg.source})`;
                            diagnostic.code = msg.fixable ? 'fixable' : undefined;
                            diagnostics.push(diagnostic);
                        }
                    }

                    this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
                    this.outputChannel.appendLine(`[PHPCS] Found ${diagnostics.length} issues`);
                } catch (parseError) {
                    this.outputChannel.appendLine(`[PHPCS] Error: ${error.message}`);
                }
            } else {
                if (error.message && (error.message.includes('No such file or directory') || error.code === 127)) {
                    this.outputChannel.appendLine(`[PHPCS] CRITICAL: PHP executable not found. Disabling PHPCS for this session.`);
                    this.outputChannel.appendLine(`[PHPCS] Reason: ${error.message}`);
                    this.phpcsPath = null; // Disable
                } else {
                    this.outputChannel.appendLine(`[PHPCS] Error: ${error.message}`);
                }
            }
        }
    }

    public clear(document: vscode.TextDocument): void {
        this.diagnosticCollection.delete(document.uri);
    }

    public dispose(): void {
        this.diagnosticCollection.dispose();
    }

    public getDiagnosticCollection(): vscode.DiagnosticCollection {
        return this.diagnosticCollection;
    }
}
