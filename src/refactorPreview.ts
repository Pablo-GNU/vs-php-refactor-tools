import * as vscode from 'vscode';
import * as fs from 'fs-extra';
// @ts-ignore
import { Engine } from 'php-parser';
import { getNamespaceFromPath } from './psr4';
import { Indexer } from './indexer';

/**
 * Creates a WorkspaceEdit for file rename refactoring WITHOUT applying it
 * This allows VS Code to show the preview before applying
 */
export async function createRefactorEdit(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    indexer: Indexer,
    outputChannel: vscode.OutputChannel
): Promise<vscode.WorkspaceEdit> {
    const edit = new vscode.WorkspaceEdit();

    outputChannel.appendLine(`[Refactor Preview] Creating edit for: ${oldUri.fsPath} -> ${newUri.fsPath}`);

    // Only process PHP files
    if (!oldUri.fsPath.endsWith('.php')) {
        outputChannel.appendLine(`[Refactor Preview] Not a PHP file, skipping refactor`);
        return edit;
    }

    const parser = new Engine({
        parser: { extractDoc: true },
        ast: { withPositions: true }
    });

    try {
        const fileContent = await getFileContent(oldUri);
        const ast = parser.parseCode(fileContent, oldUri.fsPath);

        // Calculate old and new namespaces
        // For old namespace, prioritize what is actually in the file (AST) over path calculation
        // This ensures imports that match the current file content are found, even if folder structure is weird.
        const astNamespace = getNamespaceFromAst(ast);
        const calculatedOldNamespace = await getNamespaceFromPath(oldUri.fsPath);
        const oldNamespace = astNamespace || calculatedOldNamespace;

        const newNamespace = await getNamespaceFromPath(newUri.fsPath);

        outputChannel.appendLine(`[Refactor Preview] Old namespace (AST): ${astNamespace}`);
        outputChannel.appendLine(`[Refactor Preview] Old namespace (Path): ${calculatedOldNamespace}`);
        outputChannel.appendLine(`[Refactor Preview] Effective Old namespace: ${oldNamespace || '(none)'}`);
        outputChannel.appendLine(`[Refactor Preview] New namespace: ${newNamespace || '(none)'}`);

        if (oldNamespace !== newNamespace) {
            // Update namespace in the moved file
            const namespaceEdit = updateNamespaceInFile(ast, fileContent, oldNamespace, newNamespace, oldUri, outputChannel);
            if (namespaceEdit) {
                edit.set(oldUri, namespaceEdit);
            }
        }

        const className = getClassNameFromFile(ast);

        // Check for Class Rename (Filename changed)
        const path = require('path');
        const oldBaseName = path.basename(oldUri.fsPath, '.php');
        const newBaseName = path.basename(newUri.fsPath, '.php');

        // If filename changed and class name matches filename (standard PSR-4), rename the class too
        let targetClassName = className;
        let newClassName = className;

        if (oldBaseName !== newBaseName && className === oldBaseName) {
            outputChannel.appendLine(`[Refactor Preview] File rename detected: ${oldBaseName} -> ${newBaseName}`);
            outputChannel.appendLine(`[Refactor Preview] Will rename class definition: class ${className} -> class ${newBaseName}`);

            newClassName = newBaseName;

            // Rename class definition in the file
            const classRenameEdit = renameClassDefinitionInFile(ast, className!, newClassName!, oldUri, outputChannel);
            if (classRenameEdit) {
                // Merge with existing edits for this file if any
                const existing = edit.get(oldUri);
                edit.set(oldUri, [...existing, ...classRenameEdit]);
            }
        }

        // Update imports/usages in other files
        // We need to handle both Namespace change and Class Name change simultaneously
        if (targetClassName) {
            const oldFqn = oldNamespace ? `${oldNamespace}\\${targetClassName}` : targetClassName;
            const newFqn = newNamespace ? `${newNamespace}\\${newClassName!}` : newClassName!;

            await updateImportsInOtherFiles(
                edit,
                oldFqn,
                newFqn,
                oldNamespace,
                newNamespace,
                oldUri,
                indexer,
                parser,
                outputChannel
            );
        }

    } catch (err: any) {
        outputChannel.appendLine(`[Refactor Preview] Error: ${err.message}`);
    }

    return edit;
}

function renameClassDefinitionInFile(
    ast: any,
    oldName: string,
    newName: string,
    uri: vscode.Uri,
    outputChannel: vscode.OutputChannel
): vscode.TextEdit[] | null {
    const edits: vscode.TextEdit[] = [];
    if (!ast || !ast.children) return null;

    for (const node of ast.children) {
        // Handle namespace children case
        const children = (node.kind === 'namespace') ? node.children : [node];

        for (const child of children) {
            if ((child.kind === 'class' || child.kind === 'interface' || child.kind === 'trait') && child.name) {
                const name = typeof child.name === 'string' ? child.name : child.name.name;
                if (name === oldName && child.loc) {
                    // php-parser location for class might include "class Name" or just "Name" depending on version/config
                    // Usually child.name.loc is the identifier location if available, otherwise we verify text
                    let range: vscode.Range;

                    if (child.name.loc) {
                        range = new vscode.Range(
                            new vscode.Position(child.name.loc.start.line - 1, child.name.loc.start.column),
                            new vscode.Position(child.name.loc.end.line - 1, child.name.loc.end.column)
                        );
                    } else {
                        // Fallback logic not ideal, but assuming 'name' property is simple string
                        // Let's rely on standard AST structure having name loc
                        // If not, we skip (safety)
                        continue;
                    }

                    edits.push(vscode.TextEdit.replace(range, newName));
                    outputChannel.appendLine(`[Refactor Preview] Will rename class definition: ${oldName} -> ${newName}`);
                    return edits;
                }
            }
        }
    }
    return null;
}



function getNamespaceFromAst(ast: any): string | null {
    if (!ast || !ast.children) return null;
    for (const node of ast.children) {
        if (node.kind === 'namespace') {
            // Handle different php-parser versions/structures for name
            return typeof node.name === 'string' ? node.name : (node.name.name || node.name);
        }
    }
    return null;
}

function getClassNameFromFile(ast: any): string | null {
    if (!ast || !ast.children) return null;

    for (const node of ast.children) {
        if (node.kind === 'namespace' && node.children) {
            for (const child of node.children) {
                if (child.kind === 'class' || child.kind === 'interface' || child.kind === 'trait') {
                    return typeof child.name === 'string' ? child.name : child.name.name;
                }
            }
        } else if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
            return typeof node.name === 'string' ? node.name : node.name.name;
        }
    }
    return null;
}

function updateNamespaceInFile(
    ast: any,
    content: string,
    oldNs: string | null,
    newNs: string | null,
    uri: vscode.Uri,
    outputChannel: vscode.OutputChannel
): vscode.TextEdit[] | null {
    const edits: vscode.TextEdit[] = [];

    if (!ast || !ast.children) return null;

    for (const node of ast.children) {
        if (node.kind === 'namespace' && node.loc) {
            if (newNs) {
                // Replace existing namespace
                // We must be careful to ONLY replace the namespace declaration, NOT the whole block
                // php-parser's node.loc for a namespace might include the entire file content if it thinks it's a block

                const range = getNamespaceDeclarationRange(content, node.loc.start.line, node.loc.start.column);
                edits.push(vscode.TextEdit.replace(range, `namespace ${newNs};`));
                outputChannel.appendLine(`[Refactor Preview] Will update namespace declaration`);
            }
            return edits;
        }
    }

    // No namespace found, add one if needed
    if (newNs) {
        const firstLine = new vscode.Position(0, 0);
        edits.push(vscode.TextEdit.insert(firstLine, `<?php\n\nnamespace ${newNs};\n\n`));
        outputChannel.appendLine(`[Refactor Preview] Will add namespace declaration`);
    }

    return edits.length > 0 ? edits : null;
}

function getNamespaceDeclarationRange(content: string, startLine: number, startColumn: number): vscode.Range {
    // startLine is 1-based from AST
    const lines = content.split('\n');
    const startLineIdx = startLine - 1;

    // Safety check
    if (startLineIdx >= lines.length) {
        return new vscode.Range(new vscode.Position(startLineIdx, 0), new vscode.Position(startLineIdx, 0));
    }

    // Look for the semicolon starting from the namespace declaration line
    for (let i = startLineIdx; i < lines.length; i++) {
        const line = lines[i];
        const searchStartCol = (i === startLineIdx) ? startColumn : 0;
        const semiColonIdx = line.indexOf(';', searchStartCol);

        if (semiColonIdx !== -1) {
            // Found it! Range ends after the semicolon
            return new vscode.Range(
                new vscode.Position(startLineIdx, startColumn),
                new vscode.Position(i, semiColonIdx + 1)
            );
        }
    }

    // Fallback: If no semicolon found (weird), just replace the line content
    return new vscode.Range(
        new vscode.Position(startLineIdx, startColumn),
        new vscode.Position(startLineIdx, lines[startLineIdx].length)
    );
}

async function updateImportsInOtherFiles(
    edit: vscode.WorkspaceEdit,
    oldFqn: string,
    newFqn: string,
    oldNs: string | null,
    newNs: string | null,
    movedFile: vscode.Uri,
    indexer: Indexer,
    parser: any,
    outputChannel: vscode.OutputChannel
): Promise<void> {

    outputChannel.appendLine(`[Refactor Preview] Searching for usages of: ${oldFqn}`);

    // Get all PHP files in workspace
    const phpFiles = await vscode.workspace.findFiles('**/*.php', '**/vendor/**');

    for (const fileUri of phpFiles) {
        if (fileUri.fsPath === movedFile.fsPath) continue;

        try {
            const content = await getFileContent(fileUri);
            const ast = parser.parseCode(content, fileUri.fsPath);

            // We need to pass namespaces correctly to handle implicit usage checks
            const fileEdits = findAndUpdateImports(ast, content, oldFqn, newFqn, oldNs, newNs, fileUri, outputChannel);
            if (fileEdits && fileEdits.length > 0) {
                edit.set(fileUri, fileEdits);
                outputChannel.appendLine(`[Refactor Preview] Will update ${fileEdits.length} import(s) in: ${fileUri.fsPath}`);
            }
        } catch (err: any) {
            // Ignore parse errors in other files
        }
    }
}

function findAndUpdateImports(
    ast: any,
    content: string,
    oldFqn: string,
    newFqn: string,
    oldNs: string | null,
    newNs: string | null,
    uri: vscode.Uri,
    outputChannel: vscode.OutputChannel
): vscode.TextEdit[] | null {
    const edits: vscode.TextEdit[] = [];
    let currentFileNamespace: string | null = null;
    let hasExistingImport = false;
    let lastUseStatementEnd: vscode.Position | null = null;
    let namespaceEnd: vscode.Position | null = null;
    let shouldRenameUsages = false;

    // First pass: Analyze file structure (Namespace, existing imports)
    if (ast && ast.children) {
        for (const node of ast.children) {
            if (node.kind === 'namespace') {
                currentFileNamespace = node.name;
                if (node.loc) {
                    namespaceEnd = new vscode.Position(node.loc.start.line, 0); // Correctly position after namespace line
                    // Actually, let's find the semicolon
                    const lines = content.split('\n');
                    const startLine = node.loc.start.line - 1;
                    for (let i = startLine; i < lines.length; i++) {
                        if (lines[i].includes(';')) {
                            namespaceEnd = new vscode.Position(i + 1, 0);
                            break;
                        }
                    }
                }
            }
            if (node.kind === 'usegroup' && node.items) {
                if (node.loc) {
                    lastUseStatementEnd = new vscode.Position(node.loc.end.line, 0);
                }
                for (const item of node.items) {
                    const useName = typeof item.name === 'string' ? item.name : item.name.name;
                    // Verify if the class is already imported
                    if (useName === oldFqn || (oldFqn && useName.endsWith('\\' + oldFqn.split('\\').pop()))) {
                        hasExistingImport = true;
                    }
                }
            }
        }
    }

    const simpleClassName = oldFqn.split('\\').pop();

    // If we are in the SAME namespace as the OLD class location, and there is NO existing import,
    // we might be using the class implicitly. We need to check for usages and ADD an import.
    // Also, if simple names match, check usages.
    if (currentFileNamespace === oldNs && !hasExistingImport && simpleClassName) {
        let usageFound = false;

        const checkUsage = (nodes: any[]) => {
            if (!nodes || usageFound) return;
            for (const node of nodes) {
                // Check for Type Hints, "new Class", Static calls, extends, implements
                // 1. Class instantiation: new SearchExampleQuery()
                if (node.kind === 'new' && node.what) {
                    const name = node.what.name;
                    if (name === simpleClassName) usageFound = true;
                }
                // 2. Type hints in functions/methods
                if ((node.kind === 'method' || node.kind === 'function') && node.arguments) {
                    for (const arg of node.arguments) {
                        if (arg.type && arg.type.name === simpleClassName) usageFound = true;
                    }
                }
                // 3. Return types
                if ((node.kind === 'method' || node.kind === 'function') && node.type) {
                    if (node.type.name === simpleClassName) usageFound = true;
                }
                // 4. Extends / Implements
                if (node.kind === 'class') {
                    if (node.extends && node.extends.name === simpleClassName) usageFound = true;
                    if (node.implements) {
                        for (const imp of node.implements) {
                            if (imp.name === simpleClassName) usageFound = true;
                        }
                    }
                }
                // 5. Static calls: Class::method()
                if (node.kind === 'staticlookup' && node.what) {
                    if (node.what.name === simpleClassName) usageFound = true;
                }

                if (usageFound) return;

                // Recurse
                if (node.children) checkUsage(node.children);
                if (node.body) {
                    const body = Array.isArray(node.body) ? node.body : (node.body.children || []);
                    checkUsage(body);
                }
                if (node.arguments) checkUsage(node.arguments);
            }
        };

        if (ast && ast.children) {
            checkUsage(ast.children);
        }

        if (usageFound) {
            shouldRenameUsages = true;
            outputChannel.appendLine(`[Refactor Preview] Implicit usage found in ${uri.fsPath}. Adding import for ${newFqn}`);
            // Add import statement
            const importStr = `use ${newFqn};\n`;
            let insertPos = lastUseStatementEnd;

            if (!insertPos) {
                // No existing imports. Insert after namespace
                if (namespaceEnd) {
                    insertPos = namespaceEnd;
                    // Add an extra newline for separation if inserting after namespace
                    // But strictly, just 'use ...\n' is enough if it's on a new line.
                } else {
                    // No namespace? Insert at top after <?php check
                    insertPos = new vscode.Position(1, 0); // Rough guess
                }
            }

            if (insertPos) {
                edits.push(vscode.TextEdit.insert(insertPos, importStr));
            }
        }
    }

    // Standard replacement for existing imports
    const traverse = (nodes: any[]) => {
        if (!nodes) return;

        for (const node of nodes) {
            // Update use statements
            if (node.kind === 'usegroup' && node.items) {
                for (const item of node.items) {
                    const useName = item.name;
                    const useNameStr = typeof useName === 'string' ? useName : useName.name;

                    if (useNameStr === oldFqn || useNameStr.endsWith('\\' + oldFqn.split('\\').pop())) {
                        shouldRenameUsages = true;
                        if (item.loc) {
                            // Check for redundancy: If the new class is in the same namespace as the current file, we don't need a use statement.
                            const newClassNamespace = newFqn.substring(0, newFqn.lastIndexOf('\\'));

                            // Only remove if it's a single use statement (safest for now)
                            if (newClassNamespace === currentFileNamespace && node.items.length === 1) {
                                // Redundant! Remove the whole line(s) including newline.
                                // startLine is 1-based. To remove line, we go from startLine-1 (0-based) to endLine (start of next line).
                                const range = new vscode.Range(
                                    new vscode.Position(node.loc.start.line - 1, 0),
                                    new vscode.Position(node.loc.end.line, 0)
                                );
                                edits.push(vscode.TextEdit.delete(range));
                                outputChannel.appendLine(`[Refactor Preview] Removing redundant use statement in ${uri.fsPath}`);
                            } else {
                                // Normal replace
                                const range = new vscode.Range(
                                    new vscode.Position(item.loc.start.line - 1, item.loc.start.column),
                                    new vscode.Position(item.loc.end.line - 1, item.loc.end.column)
                                );
                                edits.push(vscode.TextEdit.replace(range, newFqn));
                            }
                        }
                    }
                }
            }

            if (node.children) traverse(node.children);
            if (node.body) {
                const body = Array.isArray(node.body) ? node.body : node.body.children;
                if (body) traverse(body);
            }
        }
    };

    if (ast && ast.children) {
        traverse(ast.children);
    }

    // Pass 3: Rename usages in body if Class Name changed (and we are using it)
    const simpleOldName = oldFqn.split('\\').pop();
    const simpleNewName = newFqn.split('\\').pop();

    if (shouldRenameUsages && simpleOldName && simpleNewName && simpleOldName !== simpleNewName) {
        outputChannel.appendLine(`[Refactor Preview] Renaming usages of ${simpleOldName} to ${simpleNewName} in ${uri.fsPath}`);

        const renameUsagesTraverse = (nodes: any[]) => {
            if (!nodes) return;
            for (const node of nodes) {
                // 1. Instantiations: new OldName()
                if (node.kind === 'new' && node.what && node.what.name === simpleOldName) {
                    if (node.what.loc) {
                        const range = new vscode.Range(
                            new vscode.Position(node.what.loc.start.line - 1, node.what.loc.start.column),
                            new vscode.Position(node.what.loc.end.line - 1, node.what.loc.end.column)
                        );
                        edits.push(vscode.TextEdit.replace(range, simpleNewName));
                    }
                }

                // 2. Type Hints (params)
                if ((node.kind === 'method' || node.kind === 'function') && node.arguments) {
                    for (const arg of node.arguments) {
                        if (arg.type && arg.type.name === simpleOldName) {
                            if (arg.type.loc) {
                                const range = new vscode.Range(
                                    new vscode.Position(arg.type.loc.start.line - 1, arg.type.loc.start.column),
                                    new vscode.Position(arg.type.loc.end.line - 1, arg.type.loc.end.column)
                                );
                                edits.push(vscode.TextEdit.replace(range, simpleNewName));
                            }
                        }
                    }
                }

                // 3. Return Types
                if ((node.kind === 'method' || node.kind === 'function') && node.type && node.type.name === simpleOldName) {
                    if (node.type.loc) {
                        const range = new vscode.Range(
                            new vscode.Position(node.type.loc.start.line - 1, node.type.loc.start.column),
                            new vscode.Position(node.type.loc.end.line - 1, node.type.loc.end.column)
                        );
                        edits.push(vscode.TextEdit.replace(range, simpleNewName));
                    }
                }

                // 5. Static calls: OldName::method()
                if (node.kind === 'staticlookup' && node.what && node.what.name === simpleOldName) {
                    if (node.what.loc) {
                        const range = new vscode.Range(
                            new vscode.Position(node.what.loc.start.line - 1, node.what.loc.start.column),
                            new vscode.Position(node.what.loc.end.line - 1, node.what.loc.end.column)
                        );
                        edits.push(vscode.TextEdit.replace(range, simpleNewName));
                    }
                }

                // Generic recursion: Visit all properties that look like AST nodes or arrays of nodes
                // This guards against missing specific properties like 'expr', 'left', 'stmts', etc.
                for (const key in node) {
                    if (key === 'loc' || key === 'kind' || key === 'name' || key === 'what' || key === 'type') continue;
                    // Skip 'name', 'what', 'type' if we handled them specific logic above to avoid double procesing? 
                    // Actually, we processed specific checks but we didn't recurse into them specifically except via manual checks.
                    // Let's be safe: Simple checks above don't recurse. So we SHOULD recurse into everything.
                    // But we must avoid infinite loops if AST is cyclic (it is usually a tree, so ok).

                    const val = node[key];
                    if (Array.isArray(val)) {
                        // Check if array contains nodes
                        if (val.length > 0 && val[0] && typeof val[0] === 'object' && 'kind' in val[0]) {
                            renameUsagesTraverse(val);
                        }
                    } else if (val && typeof val === 'object' && 'kind' in val) {
                        renameUsagesTraverse([val]);
                    }
                }
            }
        };

        if (ast && ast.children) {
            renameUsagesTraverse(ast.children);
        }
    }

    return edits.length > 0 ? edits : null;
}

async function getFileContent(uri: vscode.Uri): Promise<string> {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc) {
        return doc.getText();
    }
    return fs.readFile(uri.fsPath, 'utf-8');
}

/**
 * Creates a WorkspaceEdit for renaming a method
 */
export async function createMethodRenameEdit(
    fileUri: vscode.Uri,
    oldName: string,
    newName: string,
    indexer: Indexer,
    outputChannel: vscode.OutputChannel,
    range?: vscode.Range
): Promise<vscode.WorkspaceEdit | null> {
    const edit = new vscode.WorkspaceEdit();

    // 1. Identify the Class of the method
    const content = await getFileContent(fileUri);
    const parser = new Engine({
        parser: { extractDoc: true },
        ast: { withPositions: true }
    });
    const ast = parser.parseCode(content, fileUri.fsPath);

    const className = getClassNameFromFile(ast);
    const namespace = getNamespaceFromAst(ast);

    if (!className) {
        outputChannel.appendLine("[Method Rename] Could not identify class in file.");
        return null;
    }

    const fullClassName = namespace ? `${namespace}\\${className}` : className;
    outputChannel.appendLine(`[Method Rename] Renaming ${fullClassName}::${oldName} -> ${newName}`);

    // Update definition in the file itself (ALWAYS)
    let defFound = false;
    const updateDefTraverse = (nodes: any[]) => {
        for (const node of nodes) {
            if (node.kind === 'method' && node.name.name === oldName) {
                if (node.name.loc) {
                    const range = new vscode.Range(
                        new vscode.Position(node.name.loc.start.line - 1, node.name.loc.start.column),
                        new vscode.Position(node.name.loc.end.line - 1, node.name.loc.end.column)
                    );
                    edit.replace(fileUri, range, newName);
                    defFound = true;
                }
            }
            if (node.children) updateDefTraverse(node.children);
            if (node.body && Array.isArray(node.body)) updateDefTraverse(node.body);
        }
    };
    if (ast.children) updateDefTraverse(ast.children);

    // 2. Scan Workspace for usages
    const phpFiles = await vscode.workspace.findFiles('**/*.php', '**/vendor/**');

    // Heuristic: Pre-scan files that contain "->oldName" or "::oldName" text to reduce AST parsing
    const filesToScan: vscode.Uri[] = [];
    for (const file of phpFiles) {
        // Optimisation: Read file content (from indexer or disk) -> we need current content
        try {
            const txt = await getFileContent(file);
            if (txt.includes(`->${oldName}`) || txt.includes(`::${oldName}`)) {
                filesToScan.push(file);
            }
        } catch (e) { }
    }
    outputChannel.appendLine(`[Method Rename] Scanning ${filesToScan.length} files for usages...`);

    for (const uri of filesToScan) {
        try {
            const txt = await getFileContent(uri);
            const fileAst = parser.parseCode(txt, uri.fsPath);

            // Perform Type-Aware traversal
            const fileEdits = findMethodUsages(fileAst, fullClassName, oldName, newName, indexer, outputChannel);
            if (fileEdits.length > 0) {
                edit.set(uri, fileEdits);
                outputChannel.appendLine(`[Method Rename] Found ${fileEdits.length} usage(s) in: ${uri.fsPath}`);
            }
        } catch (e: any) {
            outputChannel.appendLine(`[Method Rename] Error parsing ${uri.fsPath}: ${e.message}`);
            outputChannel.appendLine(`[Method Rename] Skipping file due to parse error`);
        }
    }

    outputChannel.appendLine(`[Method Rename] Total files with changes: ${edit.size}`);
    return edit;
}



function findMethodUsages(ast: any, targetClassFqn: string, oldMethod: string, newMethod: string, indexer: Indexer, outputChannel?: vscode.OutputChannel): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    const log = (msg: string) => { }; // Disabled for production
    // const log = (msg: string) => outputChannel?.appendLine(`[findMethodUsages] ${msg}`);

    // log(`Starting search for ${targetClassFqn}::${oldMethod}`);
    if (!ast || !ast.children) {
        // log('ERROR: AST is null or has no children');
        return edits;
    }
    // log(`AST has ${ast.children.length} top-level nodes`);

    // Helper: Correctly extract name from AST Node
    const getName = (n: any): string | null => {
        if (!n) return null;
        if (typeof n === 'string') return n;
        if (typeof n.name === 'string') return n.name;
        if (Array.isArray(n.parts)) return n.parts.join('\\');
        return null;
    };

    // Helper to resolve type from node
    const resolveType = (node: any): string | null => {
        if (!node) return null;
        if (node.kind === 'new' && node.what) {
            return getName(node.what);
        }
        return null;
    };

    // Phase 1: Collect imports and build type alias map
    const imports = new Map<string, string>(); // shortName -> FQN
    const collectImports = (nodes: any[]) => {
        if (!nodes) return;
        for (const node of nodes) {
            if (node.kind === 'usegroup' && node.items) {
                for (const item of node.items) {
                    const fqn = getName(item.name);
                    if (fqn) {
                        const shortName = fqn.split('\\').pop();
                        if (shortName) {
                            imports.set(shortName, fqn);
                        }
                    }
                }
            }
            if (node.children) collectImports(node.children);
        }
    };
    if (ast.children) collectImports(ast.children);

    // Phase 2: Collect class properties and their types
    const classProperties = new Map<string, string>(); // propertyName -> type
    const collectClassProperties = (nodes: any[]) => {
        if (!nodes) return;
        for (const node of nodes) {
            if (node.kind === 'class' && node.body) {
                for (const member of node.body) {
                    if (member.kind === 'propertystatement') {
                        for (const prop of member.properties || []) {
                            const propName = getName(prop);
                            if (propName && member.type) {
                                const typeName = getName(member.type);
                                if (typeName) {
                                    // Resolve via imports
                                    const resolvedType = imports.get(typeName) || typeName;
                                    classProperties.set(propName, resolvedType);
                                }
                            }
                        }
                    }
                }
            }
            if (node.children) collectClassProperties(node.children);
        }
    };
    if (ast.children) collectClassProperties(ast.children);

    // Phase 3: Traverse and track types with enhanced resolution
    let nodeCount = 0;
    const traverse = (nodes: any[], scope: Map<string, string>) => {
        if (!nodes) return;
        for (const node of nodes) {
            nodeCount++;
            // Reduced logging for performance
            // log(`Visiting node #${nodeCount}: kind=${node.kind || 'UNKNOWN'}`);

            // 1. Handle Function/Method Definitions (New Scope)
            if (node.kind === 'function' || node.kind === 'method' || node.kind === 'closure') {
                const functionScope = new Map<string, string>(scope);

                // Add arguments with type hints to scope
                if (node.arguments) {
                    for (const arg of node.arguments) {
                        if (arg.type) {
                            const typeName = getName(arg.type);
                            const varName = getName(arg.name);

                            if (typeName && varName) {
                                // Resolve via imports
                                let resolvedType = imports.get(typeName) || typeName;

                                // Check if matches target (FQN or short name)
                                if (targetClassFqn.endsWith(resolvedType) || resolvedType === targetClassFqn || targetClassFqn.endsWith('\\' + resolvedType)) {
                                    functionScope.set(varName, targetClassFqn);
                                }
                            }
                        }
                    }
                }

                // Traverse body with new scope
                if (node.body) {
                    const bodyNodes = Array.isArray(node.body) ? node.body : (node.body.children || []);
                    traverse(bodyNodes, functionScope);
                }
                continue;
            }

            // 2. Track assignments: $var = new Class() or $var = $typedVar
            if (node.kind === 'assign' && node.left && node.right && node.left.kind === 'variable') {
                const varName = getName(node.left);

                if (varName) {
                    // Case 1: new ClassName()
                    const type = resolveType(node.right);
                    if (type) {
                        const resolvedType = imports.get(type) || type;
                        if (targetClassFqn.endsWith(resolvedType) || resolvedType === targetClassFqn || targetClassFqn.endsWith('\\' + resolvedType)) {
                            scope.set(varName, targetClassFqn);
                        }
                    }
                    // Case 2: $var = $anotherVar (copy type)
                    else if (node.right.kind === 'variable') {
                        const sourceVar = getName(node.right);
                        if (sourceVar) {
                            const sourceType = scope.get(sourceVar);
                            if (sourceType) {
                                scope.set(varName, sourceType);
                            }
                        }
                    }
                    // Case 3: $var = $this->property
                    else if (node.right.kind === 'propertylookup') {
                        const propLookup = node.right;
                        if (propLookup.what && propLookup.what.kind === 'variable') {
                            const objVar = getName(propLookup.what);
                            const propName = getName(propLookup.offset);

                            if (objVar === 'this' && propName) {
                                const propType = classProperties.get(propName);
                                if (propType && (targetClassFqn.endsWith(propType) || propType === targetClassFqn || targetClassFqn.endsWith('\\' + propType))) {
                                    scope.set(varName, targetClassFqn);
                                }
                            }
                        }
                    }
                }
            }

            // 3. Method calls: $var->oldMethod()
            // Note: PHP parser uses kind='call' with nested 'propertylookup', not 'methodcall'
            if (node.kind === 'call' && node.what && node.what.kind === 'propertylookup') {
                const propLookup = node.what;
                const methodName = getName(propLookup.offset);

                log(`Found method call: ${methodName || '(null)'} at line ${propLookup.offset?.loc?.start?.line || '?'}`);

                if (methodName === oldMethod) {
                    log(`  -> MATCH! This is the method we're looking for`);
                    let valid = false;
                    let reason = '';

                    log(`  -> Checking what kind: ${propLookup.what.kind}`);

                    // Check what we're calling the method on
                    if (propLookup.what.kind === 'variable') {
                        const varName = getName(propLookup.what);
                        if (varName === 'this') {
                            valid = true;
                            reason = '$this';
                        } else if (varName) {
                            const type = scope.get(varName);
                            if (type === targetClassFqn) {
                                valid = true;
                                reason = `tracked var: $${varName}`;
                            } else {
                                reason = `untracked var: $${varName}`;
                            }
                        }
                    }
                    // $this->property->oldMethod()
                    else if (propLookup.what.kind === 'propertylookup') {
                        const innerPropLookup = propLookup.what;
                        if (innerPropLookup.what && innerPropLookup.what.kind === 'variable') {
                            const objVar = getName(innerPropLookup.what);
                            const propName = getName(innerPropLookup.offset);

                            if (objVar === 'this' && propName) {
                                const propType = classProperties.get(propName);
                                if (propType && (targetClassFqn.endsWith(propType) || propType === targetClassFqn || targetClassFqn.endsWith('\\' + propType))) {
                                    valid = true;
                                    reason = `$this->${propName}`;
                                }
                            }
                        }
                    }
                    // (new Class())->oldMethod()
                    else if (propLookup.what.kind === 'new') {
                        const type = resolveType(propLookup.what);
                        if (type) {
                            const resolvedType = imports.get(type) || type;
                            if (targetClassFqn.endsWith(resolvedType) || resolvedType === targetClassFqn || targetClassFqn.endsWith('\\' + resolvedType)) {
                                valid = true;
                                reason = `new ${type}`;
                            }
                        }
                    }
                    // Method chaining: $obj->method()->oldMethod()
                    else if (propLookup.what.kind === 'methodcall') {
                        reason = 'method chain (needs return type tracking)';
                    }
                    else {
                        reason = `unknown: ${propLookup.what.kind}`;
                    }

                    if (valid && propLookup.offset.loc) {
                        log(`  -> ✓ VALID! Adding rename edit`);
                        const range = new vscode.Range(
                            new vscode.Position(propLookup.offset.loc.start.line - 1, propLookup.offset.loc.start.column),
                            new vscode.Position(propLookup.offset.loc.end.line - 1, propLookup.offset.loc.end.column)
                        );
                        edits.push(vscode.TextEdit.replace(range, newMethod));
                    } else if (!valid && propLookup.offset.loc) {
                        const line = propLookup.offset.loc.start.line;
                        log(`  -> ✗ SKIPPED at line ${line}: ${reason}`);
                        console.log(`[findMethodUsages] Skipped ${oldMethod} at line ${line}: ${reason}`);
                    }
                }
            }

            // 4. Handle class bodies explicitly
            if (node.kind === 'class' && node.body) {
                traverse(node.body, scope);
            }

            // 5. Handle namespace bodies
            if (node.kind === 'namespace' && node.children) {
                traverse(node.children, scope);
            }

            // Recurse into other properties (but skip body since we handle it explicitly above)
            for (const key in node) {
                if (key === 'loc' || key === 'kind' || key === 'name' || key === 'what' || key === 'type' || key === 'body' || key === 'children') continue;
                const val = node[key];
                if (Array.isArray(val)) {
                    if (val.length > 0 && typeof val[0] === 'object' && val[0].kind) traverse(val, scope);
                } else if (val && typeof val === 'object' && val.kind) {
                    traverse([val], scope);
                }
            }
        }
    };

    if (ast.children) traverse(ast.children, new Map());
    return edits;
}
