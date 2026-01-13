import * as vscode from 'vscode';
// @ts-ignore
import { Engine } from 'php-parser';

export class PhpDocProvider implements vscode.CodeActionProvider {
    private parser: any;

    constructor() {
        this.parser = new Engine({
            parser: { extractDoc: true },
            ast: { withPositions: true }
        });
    }

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {

        const text = document.getText();
        let ast = null;
        try {
            ast = this.parser.parseCode(text, document.uri.fsPath);
        } catch (e) {
            return [];
        }

        const actions: vscode.CodeAction[] = [];
        const cursorLine = range.start.line + 1;

        const traverse = (nodes: any[]) => {
            for (const node of nodes) {
                if (node.loc && cursorLine >= node.loc.start.line && cursorLine <= node.loc.end.line) {

                    // 1. Methods
                    if (node.kind === 'method' || node.kind === 'function') {
                        const existingDocRange = this.getDocRange(document, node);
                        if (!existingDocRange) {
                            const action = this.createDocAction(document, node, 'method', null);
                            if (action) actions.push(action);
                        } else {
                            // Offer Update
                            const action = this.createDocAction(document, node, 'method', existingDocRange);
                            if (action) {
                                action.title = "Update PHPDoc for method";
                                actions.push(action);
                            }
                        }
                    }
                    // 2. Classes
                    else if (node.kind === 'class') {
                        const existingDocRange = this.getDocRange(document, node);

                        if (cursorLine === node.loc.start.line) {
                            if (!existingDocRange) {
                                const action = this.createDocAction(document, node, 'class', null);
                                if (action) actions.push(action);
                            } else {
                                // Update Class Doc
                                const action = this.createDocAction(document, node, 'class', existingDocRange);
                                if (action) {
                                    action.title = "Update PHPDoc for class";
                                    actions.push(action);
                                }
                            }
                        }
                    }

                    if (node.children) traverse(node.children);
                    if (node.body) {
                        if (Array.isArray(node.body)) traverse(node.body);
                        else if (node.body.children) traverse(node.body.children);
                    }
                }
            }
        };

        if (ast.children) traverse(ast.children);
        return actions;
    }

    /**
     * Scans backwards to find the exact range of a DocBlock.
     */
    private getDocRange(document: vscode.TextDocument, node: any): vscode.Range | null {
        if (!node.loc) return null;
        let lineIdx = node.loc.start.line - 2; // Start checking line before definition (1-based -> 0-based - 1)

        // Skip whitespace/empty lines
        while (lineIdx >= 0) {
            const lineHtml = document.lineAt(lineIdx).text.trim();
            if (lineHtml !== '') break;
            lineIdx--;
        }

        if (lineIdx < 0) return null;

        // Verify it ends with */
        const endLine = document.lineAt(lineIdx);
        if (!endLine.text.trim().endsWith('*/')) return null;

        // Walk back to find /**
        let startLineIdx = lineIdx;
        while (startLineIdx >= 0) {
            const text = document.lineAt(startLineIdx).text.trim();
            if (text.startsWith('/**')) {
                // Found it
                return new vscode.Range(
                    new vscode.Position(startLineIdx, 0),
                    endLine.range.end
                );
            }
            if (startLineIdx === lineIdx && !text.endsWith('*/')) {
                // Should have caught this above, but safeguards.
                return null;
            }
            startLineIdx--;
        }

        return null;
    }

    private createDocAction(document: vscode.TextDocument, node: any, type: 'class' | 'method', replaceRange: vscode.Range | null): vscode.CodeAction | null {
        const action = new vscode.CodeAction(`Generate PHPDoc for ${type}`, vscode.CodeActionKind.RefactorRewrite);
        const edit = new vscode.WorkspaceEdit();

        // 1. Parse existing if any
        let existingData: any = {};
        if (replaceRange) {
            existingData = this.parseDocBlock(document.getText(replaceRange));
        }

        // 2. Build new content
        let docBlockLines: string[] = [];
        docBlockLines.push("/**");

        if (type === 'class') {
            const className = node.name.name || node.name;
            docBlockLines.push(` * Class ${className}`);
            // Preserve description if exists
            if (existingData.description) {
                // If the description was just "Class Foo", we ignore it to avoid duplication? 
                // Or just append extra lines.
                // Simple: add non-empty description lines.
                existingData.description.forEach((l: string) => {
                    if (!l.trim().startsWith('Class ' + className) && !l.trim().startsWith('* Class ' + className)) {
                        docBlockLines.push(` * ${l}`);
                    }
                });
            }

            // Package (Naive merge)
            if (existingData.tags && existingData.tags['package']) {
                docBlockLines.push(` * @package ${existingData.tags['package']}`);
            } else {
                docBlockLines.push(` * @package App`);
            }

        } else if (type === 'method') {
            // Description
            if (existingData.description && existingData.description.length > 0) {
                existingData.description.forEach((l: string) => docBlockLines.push(` * ${l}`));
            } else {
                docBlockLines.push(" * [Description]");
            }
            docBlockLines.push(" *");

            // Params
            if (node.arguments) {
                for (const arg of node.arguments) {
                    const argName = arg.name.name || arg.name;
                    const argType = arg.type ? this.resolveType(arg.type) : 'mixed';

                    // Check if we had this param
                    let desc = '';
                    let existingType = argType; // Default to current code type

                    if (existingData.params && existingData.params[argName]) {
                        desc = existingData.params[argName].desc;
                        // We prefer the NODE type usually, unless it's mixed and the DOC had a better type?
                        // "Product" logic: Code is truth for Type presence, but Doc is truth for Type definition (e.g. array<int>)
                        // If code has specific type 'string', use it. If code has no type, keep Doc type.
                        if (argType === 'mixed' && existingData.params[argName].type) {
                            existingType = existingData.params[argName].type;
                        }
                    }

                    docBlockLines.push(` * @param ${existingType} $${argName} ${desc}`.trim());
                }
            }

            // Return
            let returnType = node.type ? this.resolveType(node.type) : 'void';
            if (existingData.return) {
                // Keep doc type if code is void/mixed? Or blindly complete?
                // Let's allow manual return types to persist if valid.
                // But if code changed valid return type, code wins.
            }
            docBlockLines.push(` * @return ${returnType}`);
        }

        docBlockLines.push(" */");

        // 3. Render
        const line = document.lineAt(node.loc.start.line - 1);
        const indentation = line.text.substring(0, line.firstNonWhitespaceCharacterIndex);

        const infoBlock = docBlockLines.map(l => indentation + l).join('\n');

        if (replaceRange) {
            // Update: Replace the existing range
            edit.replace(document.uri, replaceRange, infoBlock);
        } else {
            // Create: Insert
            edit.insert(document.uri, new vscode.Position(node.loc.start.line - 1, 0), infoBlock + "\n");
        }

        action.edit = edit;
        return action;
    }

    private resolveType(typeNode: any): string {
        if (!typeNode) return 'mixed';
        if (typeof typeNode === 'string') return typeNode;
        if (typeNode.kind === 'Identifier') return typeNode.name;
        if (typeNode.name) return typeNode.name;
        return 'mixed';
    }

    private parseDocBlock(text: string): any {
        const lines = text.split('\n').map(l => l.trim().replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*\s?/, ''));

        const data: any = { description: [], params: {}, tags: {} };

        for (const l of lines) {
            if (l.startsWith('@param')) {
                // @param type $name desc...
                const match = l.match(/@param\s+([^\s]+)\s+\$([a-zA-Z0-9_]+)(.*)/);
                if (match) {
                    data.params[match[2]] = { type: match[1], desc: match[3].trim() };
                }
            } else if (l.startsWith('@return')) {
                // @return type desc
                data.return = l; // Store raw for now
            } else if (l.startsWith('@')) {
                // Other tags
                const match = l.match(/@([a-z]+)\s+(.*)/);
                if (match) {
                    data.tags[match[1]] = match[2];
                }
            } else {
                if (l !== '') data.description.push(l);
            }
        }
        return data;
    }
}
