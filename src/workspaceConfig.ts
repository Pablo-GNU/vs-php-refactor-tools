import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';

export async function initializeWorkspaceConfig(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const vscodeDir = path.join(workspaceRoot, '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');

    // Check if .vscode/settings.json already exists
    if (await fs.pathExists(settingsPath)) {
        const choice = await vscode.window.showWarningMessage(
            '.vscode/settings.json already exists. Do you want to merge PHP Refactor Tools settings?',
            'Merge',
            'Cancel'
        );

        if (choice !== 'Merge') {
            return;
        }
    }

    // Ensure .vscode directory exists
    await fs.ensureDir(vscodeDir);

    // Default PHP Refactor Tools configuration
    const phpRefactorToolsConfig = {
        // Indexer
        "phpRefactorTools.indexer.excludeVendor": false,
        "phpRefactorTools.indexer.exclude": ["node_modules", "storage", "var"],

        // PHPStan
        "phpRefactorTools.phpstan.enabled": true,
        "phpRefactorTools.phpstan.configFile": "phpstan.neon",
        "phpRefactorTools.phpstan.level": "max",

        // PHPCS
        "phpRefactorTools.phpcs.enabled": true,
        "phpRefactorTools.phpcs.standard": "PSR12",
        "phpRefactorTools.phpcs.configFile": "",

        // PHP-CS-Fixer
        "phpRefactorTools.phpCsFixer.enabled": true,
        "phpRefactorTools.phpCsFixer.configFile": ".php-cs-fixer.php",
        "phpRefactorTools.phpCsFixer.onSave": false
    };

    let existingSettings = {};

    // Read existing settings if file exists
    if (await fs.pathExists(settingsPath)) {
        try {
            const content = await fs.readFile(settingsPath, 'utf-8');
            existingSettings = JSON.parse(content);
        } catch (e) {
            vscode.window.showErrorMessage('Failed to parse existing settings.json');
            return;
        }
    }

    // Merge with existing settings
    const mergedSettings = {
        ...existingSettings,
        ...phpRefactorToolsConfig
    };

    // Write to file
    await fs.writeFile(
        settingsPath,
        JSON.stringify(mergedSettings, null, 2),
        'utf-8'
    );

    vscode.window.showInformationMessage(
        'PHP Refactor Tools configuration created in .vscode/settings.json'
    );

    // Optionally open the file
    const doc = await vscode.workspace.openTextDocument(settingsPath);
    await vscode.window.showTextDocument(doc);
}
