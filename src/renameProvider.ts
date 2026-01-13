import * as vscode from 'vscode';
import { Indexer } from './indexer';
import * as fs from 'fs-extra';
// @ts-ignore
import { Engine } from 'php-parser';

export class PhpRenameProvider implements vscode.RenameProvider {
    private indexer: Indexer;
    private parser: any;

    constructor(indexer: Indexer) {
        this.indexer = indexer;
        this.parser = new Engine({
            parser: { extractDoc: true },
            ast: { withPositions: true }
        });
    }

    private extractVarName(node: any): string | null {
        if (!node) return null;
        if (node.kind === 'variable') {
            return node.name;
        }
        return null;
    }

    public async provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        token: vscode.CancellationToken
    ): Promise<vscode.WorkspaceEdit> {
        const workspaceEdit = new vscode.WorkspaceEdit();

        const range = document.getWordRangeAtPosition(position);
        if (!range) return workspaceEdit; // Empty

        const oldName = document.getText(range);

        // STEP 1: Detect if we're renaming a method and find the target class
        let targetClassName: string | null = null;
        let targetType: 'class' | 'interface' | 'trait' | null = null;  // NEW: Track type
        let isMethodRename = false;
        let targetImplementations: string[] = [];  // NEW: For interface implementations

        try {
            const currentAst = this.parser.parseCode(document.getText(), document.uri.fsPath);
            const currentOffset = document.offsetAt(position);

            const findMethodContext = (nodes: any[], currentClass: string | null = null): boolean => {
                if (!nodes) return false;

                for (const node of nodes) {
                    if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                        const className = typeof node.name === 'string' ? node.name : node.name.name;

                        // Check methods in this class
                        const checkBody = (bodyNodes: any[]) => {
                            if (!bodyNodes) return false;
                            for (const bodyNode of bodyNodes) {
                                if (bodyNode.kind === 'method' && bodyNode.loc) {
                                    const methodName = typeof bodyNode.name === 'string'
                                        ? bodyNode.name : bodyNode.name.name;

                                    if (methodName === oldName) {
                                        const start = bodyNode.loc.start.offset ||
                                            (document.offsetAt(new vscode.Position(bodyNode.loc.start.line - 1, bodyNode.loc.start.column)));
                                        const end = bodyNode.loc.end.offset ||
                                            (document.offsetAt(new vscode.Position(bodyNode.loc.end.line - 1, bodyNode.loc.end.column)));

                                        if (currentOffset >= start && currentOffset <= end) {
                                            targetClassName = className;
                                            targetType = node.kind as 'class' | 'interface' | 'trait';  // NEW
                                            isMethodRename = true;
                                            return true;
                                        }
                                    }
                                }
                            }
                            return false;
                        };

                        if (node.body) {
                            const body = Array.isArray(node.body) ? node.body : node.body.children;
                            if (body && checkBody(body)) return true;
                        }

                        // Recurse into nested classes
                        if (node.children && findMethodContext(node.children, className)) {
                            return true;
                        }
                    }

                    if (node.children && findMethodContext(node.children, currentClass)) {
                        return true;
                    }
                }
                return false;
            };

            findMethodContext(currentAst.children);
        } catch (e) {
            console.warn('Error detecting method context:', e);
        }

        // STEP 2: Find all implementations if renaming an interface method
        if (isMethodRename && targetType === 'interface' && targetClassName) {
            targetImplementations = this.indexer.getImplementations(targetClassName);
            console.log(`Interface method rename: ${targetClassName}::${oldName}`);
            console.log(`Found ${targetImplementations.length} implementations: ${targetImplementations.join(', ')}`);
        }

        console.log(`Renaming ${oldName} -> ${newName}. ` +
            (isMethodRename ? `Method in class ${targetClassName}` : 'Class/symbol'));

        // 2. Find files to update - FIXED: Search ALL PHP files, not just files defining the class
        // This ensures we find files that USE the class (type hints, new statements, etc.)
        const allPhpFiles = await vscode.workspace.findFiles('**/*.php', '**/vendor/**');
        const candidatePaths = allPhpFiles.map(uri => uri.fsPath);

        // Include the current file even if not indexed yet (e.g. unsaved changes)
        if (!candidatePaths.includes(document.uri.fsPath)) {
            candidatePaths.push(document.uri.fsPath);
        }

        console.log(`Searching ${candidatePaths.length} files`);

        for (const filePath of candidatePaths) {
            const uri = vscode.Uri.file(filePath);
            let content = '';

            // Read file (from disk or opened document)
            // It's safer to read from disk but for opened docs we might want dirty content?
            // VS Code rename usually works on saved state or open documents.
            // Let's read from disk for simplicity in this PoC, or check if open.
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
            if (openDoc) {
                content = openDoc.getText();
            } else {
                content = await fs.readFile(filePath, 'utf8');
            }

            try {
                const ast = this.parser.parseCode(content, filePath);

                const addEdit = (node: any) => {
                    if (node.loc) {
                        const editRange = new vscode.Range(
                            new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
                            new vscode.Position(node.loc.end.line - 1, node.loc.end.column)
                        );
                        workspaceEdit.replace(uri, editRange, newName);
                    }
                };

                // CLASS-AWARE RENAME: Track variable types for type inference
                const variableTypes = new Map<string, string>(); // varName -> className
                let currentClassName: string | null = null;

                const traverse = (nodes: any[]) => {
                    for (const node of nodes) {
                        // CLASS-AWARE: Track class context and handle class/method renames
                        if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                            const prevClassName = currentClassName;
                            currentClassName = typeof node.name === 'string' ? node.name : node.name.name;

                            // 1. Class Definitions: Only rename if NOT a method rename
                            if (!isMethodRename && (node.name && (node.name.name === oldName || node.name === oldName))) {
                                if (typeof node.name === 'object' && node.name.loc) {
                                    addEdit(node.name);
                                } else if (node.name && typeof node.name !== 'string') {
                                    addEdit(node.name);
                                }
                            }

                            // 1b. Method Definitions: Rename in target class OR interface implementations
                            if (isMethodRename) {
                                // Check if we should rename in this class
                                const shouldRenameInThisClass =
                                    currentClassName === targetClassName ||  // Original class/interface
                                    (targetType === 'interface' && currentClassName !== null && targetImplementations.includes(currentClassName));  // Implementation

                                if (shouldRenameInThisClass) {
                                    const checkMethods = (bodyNodes: any[]) => {
                                        if (!bodyNodes) return;
                                        for (const bodyNode of bodyNodes) {
                                            if (bodyNode.kind === 'method') {
                                                const methodName = typeof bodyNode.name === 'string'
                                                    ? bodyNode.name : bodyNode.name.name;
                                                if (methodName === oldName) {
                                                    if (typeof bodyNode.name === 'object' && bodyNode.name.loc) {
                                                        addEdit(bodyNode.name);
                                                    } else if (bodyNode.name && typeof bodyNode.name !== 'string') {
                                                        addEdit(bodyNode.name);
                                                    }
                                                }
                                            }
                                        }
                                    };

                                    if (node.body) {
                                        const body = Array.isArray(node.body) ? node.body : node.body.children;
                                        if (body) checkMethods(body);
                                    }
                                }
                            }

                            // Traverse children and body
                            if (node.children) traverse(node.children);
                            if (node.body) {
                                const body = Array.isArray(node.body) ? node.body : node.body.children;
                                if (body) traverse(body);
                            }

                            currentClassName = prevClassName;
                            continue;
                        }


                        // 2. Usages: "use Namespace\OldName;"
                        if (node.kind === 'usegroup') {
                            for (const item of node.items) {
                                // item.name is FQN. We check if it ENDS with OldName
                                if (item.name.endsWith('\\' + oldName) || item.name === oldName) {
                                    // We want to rename just the last part?
                                    // "use App\MyClass;" -> "use App\NewClass;"
                                    // But `item` location covers "App\MyClass".
                                    // We can't easily replace just the suffix without precise location.

                                    // Strategy: Replace the whole FQN string by swapping the suffix.
                                    // This is safer.
                                    const newFQN = item.name.replace(new RegExp(oldName + '$'), newName);
                                    workspaceEdit.replace(
                                        uri,
                                        new vscode.Range(
                                            new vscode.Position(item.loc.start.line - 1, item.loc.start.column),
                                            new vscode.Position(item.loc.end.line - 1, item.loc.end.column)
                                        ),
                                        newFQN
                                    );
                                }
                            }
                        }

                        // 3. Direct Usage: \"new OldName()\" or \"OldName::static()\" - Only if NOT method rename
                        if (!isMethodRename && node.kind === 'name') {
                            // Resolving: "OldName" or "\FQN\OldName"
                            // We replace if the name part matches.
                            const parts = node.name.split('\\');
                            const shortName = parts[parts.length - 1];

                            if (shortName === oldName) {
                                // Replace the NAME node text.
                                // Wait, if we replace the whole FQN node we might break the prefix?
                                // No, we just want to rename the class name part.
                                // BUT `node.loc` covers the full name.

                                // "App\Old" -> "App\New"
                                // "Old" -> "New"

                                const newFullName = node.name.replace(new RegExp(oldName + '$'), newName);
                                addEdit(node); // This replaces with `newName` only! ERROR.

                                // We must calculate the correct replacement text.
                                // If the node text was fully qualified, we must provide the fully qualified new name?
                                // Or does `workspaceEdit.replace` replace the range with just `newName`? Yes.

                                // So:
                                // If text is "App\Old", and we replace range with "New", result is "New". -> BROKEN.
                                // We must replace with "App\New".

                                workspaceEdit.replace(
                                    uri,
                                    new vscode.Range(
                                        new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
                                        new vscode.Position(node.loc.end.line - 1, node.loc.end.column)
                                    ),
                                    newFullName
                                );
                            }
                        }

                        // 4. Method Calls: "$this->oldMethod()", "$obj->oldMethod()" - CLASS-AWARE + INTERFACE-AWARE
                        if (isMethodRename && node.kind === 'propertylookup') {
                            if (node.offset) {
                                const offsetName = typeof node.offset === 'string'
                                    ? node.offset
                                    : (node.offset.name || node.offset);

                                if (offsetName === oldName) {
                                    // Type inference: check what object is being called
                                    let shouldRename = false;

                                    // Case 1: $this->method() - same class OR implementing interface
                                    if (node.what && node.what.kind === 'variable' && node.what.name === 'this') {
                                        shouldRename =
                                            currentClassName === targetClassName ||
                                            (targetType === 'interface' && currentClassName !== null && targetImplementations.includes(currentClassName));
                                    }
                                    // Case 2: $var->method() - check variable type
                                    else if (node.what && node.what.kind === 'variable') {
                                        const varName = node.what.name;
                                        const varType = variableTypes.get(varName);
                                        shouldRename =
                                            varType === targetClassName ||
                                            (targetType === 'interface' && varType !== null && varType !== undefined && targetImplementations.includes(varType));
                                    }

                                    if (shouldRename && typeof node.offset === 'object' && node.offset.loc) {
                                        addEdit(node.offset);
                                    }
                                }
                            }
                        }

                        // 5. Static Method Calls: "ClassName::oldMethod()" - CLASS-AWARE + INTERFACE-AWARE
                        if (isMethodRename && node.kind === 'staticlookup') {
                            if (node.offset && node.what) {
                                const offsetName = typeof node.offset === 'string'
                                    ? node.offset
                                    : (node.offset.name || node.offset);

                                if (offsetName === oldName) {
                                    // Get the class name
                                    const className = node.what.name || node.what;

                                    // Rename if it matches target class/interface OR implementation
                                    const shouldRename =
                                        className === targetClassName ||
                                        (currentClassName === targetClassName && (className === 'self' || className === 'static')) ||
                                        (targetType === 'interface' && targetImplementations.includes(className));

                                    if (shouldRename && typeof node.offset === 'object' && node.offset.loc) {
                                        addEdit(node.offset);
                                    }
                                }
                            }
                        }

                        if (node.children) traverse(node.children);
                        // Also traverse body for methods inside classes
                        if (node.body) {
                            if (Array.isArray(node.body)) {
                                traverse(node.body);
                            } else if (node.body.children) {
                                traverse(node.body.children);
                            }
                        }
                    }
                };

                if (ast.children) traverse(ast.children);

            } catch (e) {
                console.warn(`Rename error in ${filePath}`, e);
            }
        }

        return workspaceEdit;
    }
}
