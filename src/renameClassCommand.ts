import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';

export async function renameClassCommand(uri: vscode.Uri, currentName: string) {
    // 1. Ask for new name
    const newName = await vscode.window.showInputBox({
        prompt: 'Enter new class name',
        value: currentName,
        validateInput: async (value) => {
            if (!value || value === currentName) return 'Please enter a different name';
            if (!/^[a-zA-Z_\x7f-\xff][a-zA-Z0-9_\x7f-\xff]*$/.test(value)) return 'Invalid PHP class name';

            // Check if file already exists
            const dir = path.dirname(uri.fsPath);
            const newPath = path.join(dir, value + '.php');
            if (await fs.pathExists(newPath)) {
                return 'File already exists: ' + value + '.php';
            }
            return null;
        }
    });

    if (!newName) return;

    // 2. Perform File Rename
    // This will trigger the onWillRenameFiles event, which handles the class rename and imports update!
    const dir = path.dirname(uri.fsPath);
    const newPath = path.join(dir, newName + '.php');
    const newUri = vscode.Uri.file(newPath);

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(uri, newUri);

    // We apply this edit. VS Code will detect the rename, fire onWillRenameFiles, 
    // catch our hook in extension.ts, generate the additional refactoring edits,
    // and show the Refactor Preview.
    await vscode.workspace.applyEdit(edit);
}
