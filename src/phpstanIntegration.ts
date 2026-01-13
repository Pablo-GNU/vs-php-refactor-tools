import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface PHPStanError {
    message: string;
    line: number;
    ignorable: boolean;
}

interface PHPStanFileErrors {
    errors: number;
    messages: PHPStanError[];
}

interface PHPStanOutput {
    totals: {
        errors: number;
        file_errors: number;
    };
    files: {
        [filePath: string]: PHPStanFileErrors;
    };
    errors: string[];
}

export class PHPStanIntegration {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private phpstanPath: string | null = null;
    private workspaceRoot: string;
    private outputChannel: vscode.OutputChannel;

    constructor(workspaceRoot: string, outputChannel: vscode.OutputChannel) {
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('phpstan');
        this.detectPHPStan();
    }

    private async detectPHPStan(): Promise<void> {
        // Try vendor/bin/phpstan
        const vendorPath = path.join(this.workspaceRoot, 'vendor', 'bin', 'phpstan');
        if (await fs.pathExists(vendorPath)) {
            this.phpstanPath = path.relative(this.workspaceRoot, vendorPath);
            this.outputChannel.appendLine(`[PHPStan] Found at: ${vendorPath}`);
            return;
        }

        // Try global phpstan
        try {
            await execAsync('which phpstan');
            this.phpstanPath = 'phpstan';
            this.outputChannel.appendLine(`[PHPStan] Using global installation`);
        } catch (e) {
            this.outputChannel.appendLine(`[PHPStan] Not found. Install PHPStan for type checking: composer require --dev phpstan/phpstan`);
        }
    }

    public isAvailable(): boolean {
        return this.phpstanPath !== null;
    }

    public async analyzeFile(filePath: string): Promise<void> {
        if (!this.phpstanPath) {
            return;
        }

        this.outputChannel.appendLine(`[PHPStan] Analyzing: ${filePath}`);

        try {
            // Get PHP executable from config (default to 'php')
            const phpConfig = vscode.workspace.getConfiguration('php');
            let phpExe = phpConfig.get<string>('validate.executablePath') || 'php';

            // Resolve relative path for executable (e.g. ./php)
            if (phpExe.startsWith('./') || phpExe.startsWith('.\\')) {
                phpExe = path.resolve(this.workspaceRoot, phpExe);
            }

            // Use relative path for compatibility with container wrappers
            const relativePath = path.relative(this.workspaceRoot, filePath);

            // Run PHPStan with JSON output
            // NOTE: this.phpstanPath is already relative due to detection logic
            const command = `${phpExe} ${this.phpstanPath} analyze --error-format=json --no-progress --level=max "${relativePath}"`;

            const { stdout, stderr } = await execAsync(command, {
                cwd: this.workspaceRoot,
                timeout: 30000 // 30 second timeout
            });

            this.outputChannel.appendLine(`[PHPStan Debug] Command: ${command}`);
            this.outputChannel.appendLine(`[PHPStan Debug] Raw Output: ${stdout}`);

            // Parse JSON output
            let result: PHPStanOutput;
            try {
                result = JSON.parse(stdout);
            } catch (parseError) {
                this.outputChannel.appendLine(`[PHPStan] Failed to parse JSON output`);
                return;
            }

            // Convert to VS Code diagnostics
            const diagnostics: vscode.Diagnostic[] = [];

            // Fuzzy match file path (container path vs host path)
            let fileErrors = result.files[filePath];
            if (!fileErrors && result.files) {
                // Try finding key that ends with the relative path
                const relativeKey = Object.keys(result.files).find(key => key.endsWith(relativePath));
                if (relativeKey) {
                    fileErrors = result.files[relativeKey];
                } else {
                    // Try basename match
                    const targetBasename = path.basename(relativePath);
                    const basenameKey = Object.keys(result.files).find(key => path.basename(key) === targetBasename);
                    if (basenameKey) {
                        fileErrors = result.files[basenameKey];
                    } else if (Object.keys(result.files).length === 1) {
                        // Fallback: if there is only one file in result, use it
                        fileErrors = Object.values(result.files)[0];
                    }
                }
            }

            if (fileErrors && fileErrors.messages) {
                for (const error of fileErrors.messages) {
                    const line = error.line - 1; // PHPStan uses 1-based lines
                    const range = new vscode.Range(
                        new vscode.Position(line, 0),
                        new vscode.Position(line, 999)
                    );

                    const diagnostic = new vscode.Diagnostic(
                        range,
                        error.message,
                        vscode.DiagnosticSeverity.Error
                    );
                    diagnostic.source = 'PHPStan';
                    diagnostics.push(diagnostic);
                }
            }

            this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
            this.outputChannel.appendLine(`[PHPStan] Found ${diagnostics.length} errors`);

        } catch (error: any) {
            // PHPStan exits with code 1 when there are errors, which throws
            // Try to parse the output anyway
            if (error.stdout) {
                try {
                    const result: PHPStanOutput = JSON.parse(error.stdout);
                    const diagnostics: vscode.Diagnostic[] = [];

                    // Recalculate relativePath for catch block scope
                    const relativePath = path.relative(this.workspaceRoot, filePath);

                    // Fuzzy match file path (container path vs host path)
                    let fileErrors = result.files[filePath];
                    if (!fileErrors && result.files) {
                        // Try finding key that ends with the relative path
                        const relativeKey = Object.keys(result.files).find(key => key.endsWith(relativePath));
                        if (relativeKey) {
                            fileErrors = result.files[relativeKey];
                        } else {
                            // Try basename match
                            const targetBasename = path.basename(relativePath);
                            const basenameKey = Object.keys(result.files).find(key => path.basename(key) === targetBasename);
                            if (basenameKey) {
                                fileErrors = result.files[basenameKey];
                            } else if (Object.keys(result.files).length === 1) {
                                // Fallback: if there is only one file in result, use it
                                fileErrors = Object.values(result.files)[0];
                            }
                        }
                    }

                    if (fileErrors && fileErrors.messages) {
                        for (const err of fileErrors.messages) {
                            const line = err.line - 1;
                            const range = new vscode.Range(
                                new vscode.Position(line, 0),
                                new vscode.Position(line, 999)
                            );

                            const diagnostic = new vscode.Diagnostic(
                                range,
                                err.message,
                                vscode.DiagnosticSeverity.Error
                            );
                            diagnostic.source = 'PHPStan';
                            diagnostics.push(diagnostic);
                        }
                    }

                    this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
                    this.outputChannel.appendLine(`[PHPStan] Found ${diagnostics.length} errors`);
                } catch (parseError) {
                    this.outputChannel.appendLine(`[PHPStan] Error: ${error.message}`);
                }
            } else {
                if (error.message && (error.message.includes('No such file or directory') || error.code === 127)) {
                    this.outputChannel.appendLine(`[PHPStan] CRITICAL: PHP executable not found or command failed. Disabling PHPStan for this session.`);
                    this.outputChannel.appendLine(`[PHPStan] Reason: ${error.message}`);
                    this.phpstanPath = null; // Disable future runs
                    vscode.window.showErrorMessage('PHPStan disabled: PHP executable not found. Check Output for details.');
                } else {
                    this.outputChannel.appendLine(`[PHPStan] Error: ${error.message}`);
                }
            }
        }
    }

    public async analyzeWorkspace(): Promise<void> {
        if (!this.phpstanPath) {
            vscode.window.showWarningMessage(
                'PHPStan not found. Install it for type checking: composer require --dev phpstan/phpstan'
            );
            return;
        }

        this.outputChannel.appendLine(`[PHPStan] Analyzing entire workspace...`);

        try {
            const command = `${this.phpstanPath} analyze --error-format=json --no-progress`;

            const { stdout } = await execAsync(command, {
                cwd: this.workspaceRoot,
                timeout: 120000 // 2 minute timeout for full analysis
            });

            const result: PHPStanOutput = JSON.parse(stdout);

            // Clear all diagnostics first
            this.diagnosticCollection.clear();

            // Process all files
            for (const [filePath, fileErrors] of Object.entries(result.files)) {
                const diagnostics: vscode.Diagnostic[] = [];

                if (fileErrors.messages) {
                    for (const error of fileErrors.messages) {
                        const line = error.line - 1;
                        const range = new vscode.Range(
                            new vscode.Position(line, 0),
                            new vscode.Position(line, 999)
                        );

                        const diagnostic = new vscode.Diagnostic(
                            range,
                            error.message,
                            vscode.DiagnosticSeverity.Error
                        );
                        diagnostic.source = 'PHPStan';
                        diagnostics.push(diagnostic);
                    }
                }

                this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
            }

            this.outputChannel.appendLine(`[PHPStan] Workspace analysis complete. Total errors: ${result.totals.errors}`);

        } catch (error: any) {
            if (error.stdout) {
                // Try to parse partial results
                try {
                    const result: PHPStanOutput = JSON.parse(error.stdout);
                    this.diagnosticCollection.clear();

                    for (const [filePath, fileErrors] of Object.entries(result.files)) {
                        const diagnostics: vscode.Diagnostic[] = [];

                        if (fileErrors.messages) {
                            for (const err of fileErrors.messages) {
                                const line = err.line - 1;
                                const range = new vscode.Range(
                                    new vscode.Position(line, 0),
                                    new vscode.Position(line, 999)
                                );

                                const diagnostic = new vscode.Diagnostic(
                                    range,
                                    err.message,
                                    vscode.DiagnosticSeverity.Error
                                );
                                diagnostic.source = 'PHPStan';
                                diagnostics.push(diagnostic);
                            }
                        }

                        this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
                    }

                    this.outputChannel.appendLine(`[PHPStan] Workspace analysis complete. Total errors: ${result.totals.errors}`);
                } catch (parseError) {
                    this.outputChannel.appendLine(`[PHPStan] Workspace analysis failed: ${error.message}`);
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
