import * as vscode from 'vscode';
import * as path from 'path';
import { createMethodRenameEdit } from './refactorPreview';
import { Indexer } from './indexer';

export const renameMethodCommand = (indexer: Indexer, outputChannel: vscode.OutputChannel) => async (uri: vscode.Uri, currentName: string, range?: vscode.Range) => {
    // 1. Prompt for new name
    const newName = await vscode.window.showInputBox({
        prompt: `Rename method '${currentName}' to...`,
        value: currentName,
        validateInput: (value) => {
            if (!value || value.trim().length === 0) return 'Name cannot be empty';
            if (!/^[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*$/.test(value)) return 'Invalid PHP method name';
            return null;
        }
    });

    if (!newName || newName === currentName) {
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Renaming method to ${newName}...`,
            cancellable: false
        }, async (progress) => {
            // 2. Calculate edits (Type-Aware)
            // We pass indexer to helper to allow type lookups
            const edit = await createMethodRenameEdit(uri, currentName, newName, indexer, outputChannel, range);

            if (!edit || edit.size === 0) {
                vscode.window.showInformationMessage('No usages found to rename.');
                return;
            }

            // 3. Show preview of changes
            const affectedFiles: string[] = [];
            let totalChanges = 0;

            // Iterate over all file changes
            for (const [fileUri, fileEdits] of edit.entries()) {
                affectedFiles.push(fileUri.fsPath);
                totalChanges += fileEdits.length;
            }

            // Build preview message
            const fileList = affectedFiles.map(f => `  • ${path.basename(f)}`).join('\n');
            const message = `Rename method '${currentName}' to '${newName}'?\n\n` +
                `${totalChanges} change(s) in ${affectedFiles.length} file(s):\n${fileList}`;

            const choice = await vscode.window.showInformationMessage(
                message,
                { modal: true },
                'Apply', 'Cancel'
            );

            if (choice !== 'Apply') {
                vscode.window.showInformationMessage('Rename cancelled.');
                return;
            }

            // 4. Apply the edit
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                // 5. Re-index all modified files to keep index up-to-date
                outputChannel.appendLine('[Method Rename] Re-indexing modified files...');
                for (const [fileUri] of edit.entries()) {
                    await indexer.scanFile(fileUri);
                }
                outputChannel.appendLine('[Method Rename] Re-indexing complete.');

                vscode.window.showInformationMessage(`✓ Renamed method to '${newName}' (${totalChanges} changes)`);
            } else {
                vscode.window.showErrorMessage('Failed to apply rename edit.');
            }
        });

    } catch (error: any) {
        vscode.window.showErrorMessage(`Error renaming method: ${error.message}`);
    }
};
