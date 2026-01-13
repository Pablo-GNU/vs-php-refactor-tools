import * as vscode from 'vscode';
import * as fs from 'fs-extra';
// @ts-ignore
import { Engine } from 'php-parser';
import { getNamespaceFromPath } from './psr4';
import { Indexer } from './indexer';

export async function handleFileRename(e: vscode.FileRenameEvent, indexer: Indexer, outputChannel: vscode.OutputChannel) {
    outputChannel.appendLine(`[Refactor] handleFileRename called with ${e.files.length} files`);

    const parser = new Engine({
        parser: {
            extractDoc: true
        },
        ast: {
            withPositions: true
        }
    });

    const edit = new vscode.WorkspaceEdit();

    for (const { oldUri, newUri } of e.files) {
        outputChannel.appendLine(`[Refactor] Processing: ${oldUri.fsPath} -> ${newUri.fsPath}`);

        if (!newUri.fsPath.endsWith('.php')) {
            outputChannel.appendLine(`[Refactor] Skipping non-PHP file`);
            continue;
        }

        const oldNamespace = await getNamespaceFromPath(oldUri.fsPath);
        const newNamespace = await getNamespaceFromPath(newUri.fsPath);

        outputChannel.appendLine(`[Refactor] Move: ${oldNamespace} -> ${newNamespace}`);

        if (!oldNamespace || !newNamespace || oldNamespace === newNamespace) {
            outputChannel.appendLine(`[Refactor] Skipping: Namespace unchanged or null`);
            continue;
        }

        let text: string;
        let document: vscode.TextDocument;

        try {
            document = await vscode.workspace.openTextDocument(newUri);
            text = document.getText();
        } catch (e) {
            outputChannel.appendLine(`[Refactor] Error opening document: ${e}, trying file system`);
            try {
                text = await fs.readFile(newUri.fsPath, 'utf-8');
                document = await vscode.workspace.openTextDocument(newUri);
            } catch (e2) {
                outputChannel.appendLine(`[Refactor] Failed to read file: ${e2}`);
                continue;
            }
        }

        let ast;
        try {
            ast = parser.parseCode(text, newUri.fsPath);
        } catch (parseError: any) {
            outputChannel.appendLine(`[Refactor] Parse error: ${parseError.message}`);
            outputChannel.appendLine(`[Refactor] File content preview: ${text.substring(0, 500)}`);

            outputChannel.appendLine(`[Refactor] Attempting regex-based namespace replacement as fallback`);

            const namespaceRegex = /namespace\s+([^;]+);/;
            const match = text.match(namespaceRegex);

            if (match && match[1].trim() === oldNamespace) {
                outputChannel.appendLine(`[Refactor] Found namespace declaration, attempting replacement`);

                const namespaceOffset = text.indexOf(match[0]);
                if (namespaceOffset !== -1) {
                    const startPos = document.positionAt(namespaceOffset);
                    const endPos = document.positionAt(namespaceOffset + match[0].length);
                    const range = new vscode.Range(startPos, endPos);

                    edit.replace(newUri, range, `namespace ${newNamespace};`);
                    outputChannel.appendLine(`[Refactor] Added namespace replacement edit`);
                }
            } else {
                outputChannel.appendLine(`[Refactor] Could not find namespace declaration to replace`);
            }

            vscode.window.showWarningMessage(
                `PHP syntax error in ${newUri.fsPath.split('/').pop()}: ${parseError.message}. Only namespace was updated.`
            );

            continue;
        }

        let className = '';
        let namespaceNode: any = null;
        const imports = new Set<string>();

        const traverse = (nodes: any[]) => {
            for (const node of nodes) {
                if (node.kind === 'namespace') {
                    namespaceNode = node;
                    if (node.children) traverse(node.children);
                } else if (node.kind === 'usegroup') {
                    for (const item of node.items) {
                        const importedName = item.name;
                        imports.add(importedName.split('\\').pop()!);

                        const importedNs = importedName.substring(0, importedName.lastIndexOf('\\'));
                        if (importedNs === newNamespace) {
                            outputChannel.appendLine(`[Refactor] Removing redundant use: ${importedName}`);
                            if (node.loc) {
                                const range = new vscode.Range(
                                    new vscode.Position(node.loc.start.line - 1, 0),
                                    new vscode.Position(node.loc.end.line, 0)
                                );
                                edit.delete(newUri, range);
                            }
                        }
                    }
                } else if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                    className = node.name.name || node.name;
                } else if (node.children) {
                    traverse(node.children);
                }
            }
        };
        traverse(ast.children);

        if (namespaceNode) {
            const startLine = namespaceNode.loc.start.line - 1;
            const startCol = namespaceNode.loc.start.column;

            let endLine = startLine;
            let endCol = startCol;
            let foundSemi = false;

            for (let l = startLine; l < document.lineCount; l++) {
                const lineText = document.lineAt(l).text;
                const semiIdx = lineText.indexOf(';', l === startLine ? startCol : 0);
                if (semiIdx !== -1) {
                    endLine = l;
                    endCol = semiIdx + 1;
                    foundSemi = true;
                    break;
                }
            }

            if (foundSemi) {
                const range = new vscode.Range(new vscode.Position(startLine, startCol), new vscode.Position(endLine, endCol));
                edit.replace(newUri, range, `namespace ${newNamespace};`);
            }
        }

        if (className) {
            const traverseForImplicit = (nodes: any[]) => {
                for (const node of nodes) {
                    if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                        const checkAndAdd = (name: string) => {
                            if (!name.includes('\\') && !imports.has(name)) {
                                const missingUse = `${oldNamespace}\\${name}`;

                                outputChannel.appendLine(`[Refactor] Adding missing use: ${missingUse}`);

                                if (namespaceNode) {
                                    let insertLine = namespaceNode.loc.start.line - 1;
                                    for (let l = insertLine; l < document.lineCount; l++) {
                                        if (document.lineAt(l).text.includes(';')) {
                                            insertLine = l + 1;
                                            break;
                                        }
                                    }

                                    const insertPos = new vscode.Position(insertLine, 0);

                                    // FIXED SPACING: Always ensure blank line before use statement if needed
                                    let prefix = "\n";
                                    if (insertLine > 0) {
                                        const prevLine = document.lineAt(insertLine - 1);
                                        if (prevLine.text.trim() === '') {
                                            prefix = "";
                                        }
                                    }

                                    // FIXED SPACING: Always ensure blank line AFTER use statement
                                    let suffix = "\n";
                                    if (insertLine < document.lineCount) {
                                        const currLine = document.lineAt(insertLine);
                                        if (currLine.text.trim() === '') {
                                            // Next line already blank
                                            suffix = "\n";
                                        } else {
                                            // Next line has content, add extra newline for blank line
                                            suffix = "\n\n";
                                        }
                                    }

                                    edit.insert(newUri, insertPos, `${prefix}use ${missingUse};${suffix}`);
                                }
                            }
                        }

                        if (node.extends) {
                            const ext = node.extends;
                            const parents = Array.isArray(ext) ? ext : [ext];
                            for (const p of parents) checkAndAdd(p.name);
                        }
                        if (node.implements) {
                            for (const i of node.implements) checkAndAdd(i.name);
                        }
                    }
                    if (node.children) traverseForImplicit(node.children);
                }
            };
            traverseForImplicit(ast.children);
        }

        if (!className) continue;

        const oldFQN = `${oldNamespace}\\${className}`;
        const newFQN = `${newNamespace}\\${className}`;

        outputChannel.appendLine(`[Refactor] Updating usages: ${oldFQN} -> ${newFQN}`);

        // FIXED: Search ALL PHP files in workspace, not just files that define the class
        // This ensures we find files that USE the class (like SearchExampleQueryHandler)
        // which might not define it but need the use statement added
        const allPhpFiles = await vscode.workspace.findFiles('**/*.php', '**/vendor/**');
        const candidates = allPhpFiles;

        for (const fileUri of candidates) {
            if (fileUri.toString() === newUri.toString() || fileUri.toString() === oldUri.toString()) {
                continue;
            }

            try {
                const refDoc = await vscode.workspace.openTextDocument(fileUri);
                const refText = refDoc.getText();

                if (!refText.includes(className)) continue;

                const refAst = parser.parseCode(refText, fileUri.fsPath);

                let candidateNamespace: string | null = null;
                let candidateNamespaceNode: any = null;
                let usedImplicitly = false;
                let isAlreadyImported = false;

                const traverseRefs = (nodes: any | any[]) => {
                    const list = Array.isArray(nodes) ? nodes : [nodes];
                    for (const node of list) {
                        if (!node || typeof node !== 'object') continue;

                        if (node.kind === 'namespace') {
                            candidateNamespace = node.name;
                            candidateNamespaceNode = node;
                            if (node.children) traverseRefs(node.children);
                            continue;
                        }

                        if (node.kind === 'usegroup') {
                            for (const item of node.items) {
                                // Check if already imported
                                const importedName = item.name;
                                const alias = item.alias?.name || importedName.split('\\').pop();

                                if (alias === className) {
                                    isAlreadyImported = true;
                                }

                                if (item.name === oldFQN) {
                                    if (item.loc) {
                                        const range = new vscode.Range(
                                            new vscode.Position(item.loc.start.line - 1, item.loc.start.column),
                                            new vscode.Position(item.loc.end.line - 1, item.loc.end.column)
                                        );
                                        const originalText = refText.substring(
                                            refDoc.offsetAt(range.start),
                                            refDoc.offsetAt(range.end)
                                        );
                                        const newText = originalText.replace(oldFQN, newFQN);
                                        edit.replace(fileUri, range, newText);
                                    }
                                }
                            }
                            continue;
                        }

                        // Check for usage of the class name
                        const checkUsage = (name: string | any) => {
                            if (typeof name === 'string' && name === className) {
                                usedImplicitly = true;
                            } else if (name && name.kind === 'identifier' && name.name === className) {
                                usedImplicitly = true;
                            } else if (name && name.kind === 'name' && name.name === className) {
                                usedImplicitly = true; // Handle Name node
                            } else if (name && name.name === className) {
                                usedImplicitly = true; // Generic match
                            }
                        };

                        if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                            if (node.extends) {
                                const ext = Array.isArray(node.extends) ? node.extends : [node.extends];
                                ext.forEach((e: any) => checkUsage(e.name || e));
                            }
                            if (node.implements) {
                                node.implements.forEach((i: any) => checkUsage(i.name || i));
                            }
                        } else if (node.kind === 'new') {
                            checkUsage(node.what?.name || node.what);
                        } else if (node.kind === 'staticlookup') {
                            checkUsage(node.what?.name || node.what);
                        } else if (node.kind === 'parameter') {
                            if (node.type) checkUsage(node.type.name || node.type);
                        } else if (node.kind === 'property') {
                            if (node.type) checkUsage(node.type.name || node.type);
                        }

                        // Generic Recursion over all properties
                        for (const key in node) {
                            if (key === 'kind' || key === 'loc' || key === 'comments') continue;
                            const val = node[key];
                            if (Array.isArray(val)) {
                                traverseRefs(val);
                            } else if (typeof val === 'object' && val !== null && (val.kind || typeof val.line !== 'undefined')) {
                                // Recurse on objects that look like nodes (checking kind or line as heuristic for AST node)
                                traverseRefs([val]);
                            }
                        }
                    }
                };
                traverseRefs(refAst.children);

                // Logic to add missing import
                // FIX: Check if the file WAS in the same namespace as the moved file
                // If candidateNamespace === oldNamespace, they were in the same namespace
                // and now need an import since the moved file is in newNamespace
                if (candidateNamespace === oldNamespace && usedImplicitly && !isAlreadyImported) {
                    outputChannel.appendLine(`[Refactor] File ${fileUri.fsPath} was in same namespace (${oldNamespace}) as moved class. Now in different namespace (${newNamespace}). Adding import.`);

                    if (candidateNamespaceNode) {
                        let insertLine = candidateNamespaceNode.loc.start.line - 1;
                        // Attempt to find a good spot after namespace or existing imports
                        // Simplified: look for namespace line, search for next semi-colon

                        // Refined insert logic similar to previous one
                        for (let l = insertLine; l < refDoc.lineCount; l++) {
                            if (refDoc.lineAt(l).text.includes(';')) {
                                insertLine = l + 1;
                                break;
                            }
                        }

                        const insertPos = new vscode.Position(insertLine, 0);

                        let prefix = "\n";
                        if (insertLine > 0 && refDoc.lineAt(insertLine - 1).text.trim() === '') {
                            prefix = "";
                        }

                        let suffix = "\n";
                        if (insertLine < refDoc.lineCount) {
                            if (refDoc.lineAt(insertLine).text.trim() !== '') {
                                suffix = "\n\n";
                            }
                        }

                        edit.insert(fileUri, insertPos, `${prefix}use ${newFQN};${suffix}`);
                    }
                }

            } catch (e) {
                outputChannel.appendLine(`[Refactor] Error processing ${fileUri.fsPath}: ${e}`);
            }
        }
    }

    if (edit.size > 0) {
        await vscode.workspace.applyEdit(edit);
        outputChannel.appendLine(`[Refactor] Completed.`);
    }
}
