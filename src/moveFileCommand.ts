import * as vscode from 'vscode';
import * as path from 'path';
import { handleFileRename } from './refactor';
import { Indexer } from './indexer';

/**
 * Command to manually move a file with namespace and import updates
 * Shows preview before applying changes
 */
export async function moveFileWithRefactor(
    uri: vscode.Uri | undefined,
    indexer: Indexer,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const currentFile = uri || vscode.window.activeTextEditor?.document.uri;

    if (!currentFile || !currentFile.fsPath.endsWith('.php')) {
        vscode.window.showErrorMessage('Please select a PHP file to move');
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
    }

    // Get current relative path
    const currentRelativePath = path.relative(workspaceRoot, currentFile.fsPath);

    // Ask for new location
    const newRelativePath = await vscode.window.showInputBox({
        prompt: 'Enter new file path (relative to workspace root)',
        value: currentRelativePath,
        validateInput: (value) => {
            if (!value.endsWith('.php')) {
                return 'File must have .php extension';
            }
            if (value === currentRelativePath) {
                return 'New path must be different from current path';
            }
            return null;
        }
    });

    if (!newRelativePath) {
        return; // User cancelled
    }

    const newUri = vscode.Uri.file(path.join(workspaceRoot, newRelativePath));

    // Show information message
    const proceed = await vscode.window.showInformationMessage(
        `This will move the file and update namespace/imports. A preview will be shown before applying changes.`,
        { modal: true },
        'Continue'
    );

    if (proceed !== 'Continue') {
        return;
    }

    try {
        // Create a FileRenameEvent-like object
        const fakeEvent: vscode.FileRenameEvent = {
            files: [{ oldUri: currentFile, newUri: newUri }]
        };

        // Execute the refactor logic
        // The handleFileRename function already uses WorkspaceEdit which triggers preview
        await handleFileRename(fakeEvent, indexer, outputChannel);

        // Update index
        await indexer.removeFile(currentFile);
        await indexer.scanFile(newUri);

        outputChannel.appendLine(`[Manual Move] File moved successfully: ${currentRelativePath} -> ${newRelativePath}`);
    } catch (err: any) {
        const errorMsg = `Error moving file: ${err?.message || err}`;
        vscode.window.showErrorMessage(errorMsg);
        outputChannel.appendLine(`[Manual Move] ${errorMsg}`);
        outputChannel.appendLine(`[Manual Move] Stack: ${err?.stack}`);
    }
}
