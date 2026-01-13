const fs = require('fs-extra');
const path = require('path');
const vscode = require('vscode'); // Uses our mock
const { Engine } = require('php-parser');

// PSR-4 Logic
async function getNamespaceFromPath(filePath) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!workspaceFolder) return null;

    const composerPath = path.join(workspaceFolder.uri.fsPath, 'composer.json');
    if (!await fs.pathExists(composerPath)) return null;

    try {
        const composer = await fs.readJson(composerPath);
        const autoloads = { ...composer.autoload?.['psr-4'], ...composer['autoload-dev']?.['psr-4'] };

        let relativeFilePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        let relativeDir = path.dirname(relativeFilePath);
        relativeDir = relativeDir.split(path.sep).join('/');

        let bestMatchNamespace = '';
        let bestMatchLength = 0;

        for (const [namespace, paths] of Object.entries(autoloads)) {
            const pathArray = Array.isArray(paths) ? paths : [paths];
            for (const p of pathArray) {
                const normalizedPath = p.replace(/\/$/, '');
                if (relativeDir.startsWith(normalizedPath)) {
                    if (normalizedPath.length > bestMatchLength) {
                        bestMatchLength = normalizedPath.length;
                        const subPath = relativeDir.substring(normalizedPath.length);
                        const subNamespace = subPath.replace(/^\//, '').split('/').join('\\');
                        bestMatchNamespace = namespace + subNamespace;
                    }
                }
            }
        }
        return bestMatchNamespace.replace(/\\$/, '');
    } catch (e) {
        console.error("Error reading composer.json", e);
        return null;
    }
}

// Refactor Logic
async function handleFileRename(e) {
    const parser = new Engine({
        parser: { extractDoc: true },
        ast: { withPositions: true }
    });

    const edit = new vscode.WorkspaceEdit();

    for (const { oldUri, newUri } of e.files) {
        if (!newUri.fsPath.endsWith('.php')) continue;

        const oldNamespace = await getNamespaceFromPath(oldUri.fsPath);
        const newNamespace = await getNamespaceFromPath(newUri.fsPath);

        if (!oldNamespace || !newNamespace || oldNamespace === newNamespace) continue;

        // 1. Update the moved file itself
        const document = await vscode.workspace.openTextDocument(newUri);
        const text = document.getText();
        const ast = parser.parseCode(text, newUri.fsPath);

        let className = '';
        let namespaceNode = null;

        const traverse = (nodes) => {
            if (!nodes) return;
            for (const node of nodes) {
                if (node.kind === 'namespace') {
                    namespaceNode = node;
                    traverse(node.children);
                } else if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                    className = node.name.name || node.name;
                } else if (node.children) {
                    traverse(node.children);
                }
            }
        };
        traverse(ast.children);

        if (namespaceNode) {
            const range = new vscode.Range(
                new vscode.Position(namespaceNode.loc.start.line - 1, namespaceNode.loc.start.column),
                new vscode.Position(namespaceNode.loc.end.line - 1, namespaceNode.loc.end.column)
            );
            edit.replace(newUri, range, `namespace ${newNamespace};`);
        }

        if (!className) continue;

        const oldFQN = `${oldNamespace}\\${className}`;
        const newFQN = `${newNamespace}\\${className}`;

        console.log(`Refactoring ${oldFQN} to ${newFQN}`);

        // 2. Update references
        const candidates = await vscode.workspace.findFiles('**/*.php');

        for (const fileUri of candidates) {
            if (fileUri.toString() === newUri.toString()) continue;

            const refDoc = await vscode.workspace.openTextDocument(fileUri);
            const refText = refDoc.getText();

            if (!refText.includes(className)) continue;

            try {
                const refAst = parser.parseCode(refText, fileUri.fsPath);

                const addEdit = (node, replacement) => {
                    if (node.loc) {
                        const range = new vscode.Range(
                            new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
                            new vscode.Position(node.loc.end.line - 1, node.loc.end.column)
                        );
                        edit.replace(fileUri, range, replacement);
                    }
                };

                const traverseRefs = (nodes) => {
                    if (!nodes) return;
                    for (const node of nodes) {
                        if (node.kind === 'usegroup') {
                            for (const item of node.items) {
                                if (item.name === oldFQN) {
                                    addEdit(item, item.name.replace(oldNamespace, newNamespace));
                                }
                            }
                        }

                        if (node.kind === 'name' && node.resolution === 'fqn') {
                            if (node.name === oldFQN || node.name === '\\' + oldFQN) {
                                addEdit(node, node.name.replace(oldNamespace, newNamespace));
                            }
                        }

                        if (node.children) traverseRefs(node.children);
                    }
                };

                traverseRefs(refAst.children);

            } catch (err) {
                console.warn(`Error parsing ${fileUri.fsPath}`, err);
            }
        }
    }

    if (edit.size > 0) {
        await vscode.workspace.applyEdit(edit);
    }
}

module.exports = { handleFileRename };
