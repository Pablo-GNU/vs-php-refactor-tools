const fs = require('fs-extra');
const path = require('path');

class Uri {
    constructor(fsPath) {
        this.fsPath = fsPath;
        this.scheme = 'file';
    }
    static file(path) {
        return new Uri(path);
    }
    toString() {
        return this.fsPath;
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}

class WorkspaceEdit {
    constructor() {
        this.edits = [];
    }
    replace(uri, range, newText) {
        this.edits.push({ uri, range, newText });
    }
    get size() {
        return this.edits.length;
    }
}

const workspace = {
    workspaceFolders: [],
    getWorkspaceFolder(uri) {
        return this.workspaceFolders[0];
    },
    onDidRenameFiles: () => { return { dispose: () => { } } },
    openTextDocument: async (uri) => {
        const content = await fs.readFile(uri.fsPath, 'utf8');
        return {
            getText: () => content
        };
    },
    findFiles: async (include, exclude) => {
        // Simple glob find using glob package or just finding all php files in workspace
        // For PoC, let's just use a hardcoded list or simple recursive search
        // We will assume the test script sets up the workspace folder
        const root = workspace.workspaceFolders[0].uri.fsPath;

        async function getFiles(dir) {
            const dirents = await fs.readdir(dir, { withFileTypes: true });
            const files = await Promise.all(dirents.map((dirent) => {
                const res = path.resolve(dir, dirent.name);
                if (dirent.isDirectory()) {
                    if (res.includes('vendor') || res.includes('node_modules')) return [];
                    return getFiles(res);
                } else {
                    return res.endsWith('.php') ? [Uri.file(res)] : [];
                }
            }));
            return Array.prototype.concat(...files);
        }

        return getFiles(root);
    },
    applyEdit: async (edit) => {
        workspace.lastEdit = edit;
        console.log("Applying edits:", JSON.stringify(edit.edits, null, 2));
        for (const op of edit.edits) {
            // Read file
            const content = await fs.readFile(op.uri.fsPath, 'utf8');
            const lines = content.split('\n');
            const startLine = op.range.start.line;
            const endLine = op.range.end.line;

            // This is a simplified apply: assumes non-overlapping ranges and replacing full lines or specific ranges
            // For the namespace replacement (usually one line), we can handle it.
            // For multiple replacements, we need to sort them reverse.

            // ACTUALLY, implementing a full applyEdit is hard. 
            // For PoC verification, we can just LOG that we would apply it, 
            // OR we can trust the logic produced the edit and verify the edit object content.

            // Let's just Apply it roughly to verify the file on disk changes?
            // Actually, let's just log it and verify the LOG output in our test script.
            // Or better: Let's actually MODIFY the file so we can see the result.

            // Handling simple case: Replace ONE range.
            // If we have multiple, we need to handle offsets.
            // Let's use string manipulation.

            // We need to convert line/col to offset.
            // This is painful without a helper.
            // Let's restart: we will verify the Edit Object contains what we expect.
        }
        return true;
    }
};

module.exports = {
    Uri,
    Position,
    Range,
    WorkspaceEdit,
    workspace,
    window: {
        showInformationMessage: () => { }
    }
};
