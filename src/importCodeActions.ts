import * as vscode from 'vscode';
import { Indexer } from './indexer';

export class PhpImportCodeActions implements vscode.CodeActionProvider {
    private indexer: Indexer;

    constructor(indexer: Indexer) {
        this.indexer = indexer;
    }

    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix
    ];

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        // Only provide actions for our diagnostics
        // Provide actions for our diagnostics AND valid PHPStan/PHP errors
        const relevantDiagnostics = context.diagnostics.filter(d => {
            if (d.code === 'missing-import') return true; // Our own
            if (d.source === 'php-tools') return true;

            // Check for common PHPStan/PHP error patterns in the message
            const message = d.message.toLowerCase();
            return message.includes("not found") || message.includes("unknown class");
        });

        for (const diagnostic of relevantDiagnostics) {
            // Extract class name from diagnostic message
            // Support multiple patterns:
            // 1. Class 'Name' ... (Standard PHP/Our tool)
            // 2. Class Name not found (PHPStan)
            // 3. ... unknown class Name ... (Generic)
            let className: string | null = null;

            const matchQuotes = diagnostic.message.match(/Class '([\w\\]+)'/);
            if (matchQuotes) {
                className = matchQuotes[1];
            } else {
                const matchNotFound = diagnostic.message.match(/Class ([\w\\]+) not found/);
                if (matchNotFound) {
                    className = matchNotFound[1];
                } else {
                    const matchUnknown = diagnostic.message.match(/unknown class ([\w\\]+)/);
                    if (matchUnknown) {
                        className = matchUnknown[1];
                    }
                }
            }

            if (!className) continue;

            // Clean up FQN if caught (remove namespace parts if we only want simple name for lookup, 
            // BUT indexer.getDefinitions usually expects simple name. 
            // If we have FQN, we might want to check if it's already imported or just use the FQN directly?)
            // For now, let's extract the short name for lookup, as our index stores by short name.
            if (className.includes('\\')) {
                className = className.split('\\').pop() || className;
            }

            // Find all possible FQNs for this class
            const definitions = this.indexer.getDefinitions(className);

            if (definitions.length === 0) {
                // Offer a generic action even if not found
                const action = new vscode.CodeAction(
                    `Add import for ${className} (not found in index)`,
                    vscode.CodeActionKind.QuickFix
                );
                action.diagnostics = [diagnostic];
                action.isPreferred = false;
                actions.push(action);
                continue;
            }

            // Create an action for each possible FQN
            for (const def of definitions) {
                // Extract namespace from path (simplified)
                // We need to build the FQN
                const fqn = this.getFQNFromDefinition(def, className);

                const action = new vscode.CodeAction(
                    `Add import for ${fqn}`,
                    vscode.CodeActionKind.QuickFix
                );
                action.diagnostics = [diagnostic];
                action.isPreferred = definitions.length === 1;

                const edit = this.createImportEdit(document, fqn);

                action.edit = edit;

                actions.push(action);
            }
        }

        // Fallback: If no actions found from diagnostics, check if the user is hovering over a known class that isn't imported
        // This handles cases where the error message isn't recognized or hasn't appeared yet
        if (actions.length === 0 && range) {
            let wordRange: vscode.Range | undefined;

            if (range.isEmpty) {
                wordRange = document.getWordRangeAtPosition(range.start);
            } else {
                wordRange = new vscode.Range(range.start, range.end);
            }

            if (wordRange) {
                const word = document.getText(wordRange);
                // Simple heuristic: Class names usually start with uppercase
                if (word && /^[A-Z][a-zA-Z0-9]*$/.test(word)) { // Only try for likely class names to avoid noise
                    const definitions = this.indexer.getDefinitions(word);
                    if (definitions.length > 0) {
                        // Check if already imported
                        const blockInfo = this.getImportBlockInfo(document);
                        const isImported = blockInfo.imports.some(imp => {
                            // imp is "use Foo\Bar;"
                            // Check if it ends with word; or " as word;"
                            return imp.includes(`\\${word};`) || imp.includes(` as ${word};`);
                        });

                        if (!isImported) {
                            for (const def of definitions) {
                                const fqn = this.getFQNFromDefinition(def, word);
                                const action = new vscode.CodeAction(
                                    `Add import for ${fqn}`,
                                    vscode.CodeActionKind.QuickFix
                                );
                                // No diagnostics to attach if we are in fallback mode, 
                                // but we could attach intersecting diagnostics if we wanted to be fancy.
                                // For now, simple fallback.

                                const edit = this.createImportEdit(document, fqn);
                                action.edit = edit;
                                actions.push(action);
                            }
                        }
                    }
                }
            }
        }

        return actions;
    }

    private createImportEdit(document: vscode.TextDocument, fqn: string): vscode.WorkspaceEdit {
        const edit = new vscode.WorkspaceEdit();
        const blockInfo = this.getImportBlockInfo(document);

        // Add new import
        const newImportLine = `use ${fqn};`;
        const allImports = new Set(blockInfo.imports);
        allImports.add(newImportLine);

        // Sort imports alphabetically
        const sortedImports = Array.from(allImports).sort((a, b) => a.localeCompare(b));
        const importBlockText = sortedImports.join('\n');

        if (blockInfo.range) {
            // Replace existing block
            edit.replace(document.uri, blockInfo.range, importBlockText);
        } else {
            // Insert new block
            // Check previous line for newline requirement
            let prefix = '';
            if (blockInfo.insertLine > 0) {
                const prevLine = document.lineAt(blockInfo.insertLine - 1).text;
                if (prevLine.trim() !== '') {
                    prefix = '\n';
                }
            }

            // Check next line for newline requirement
            let suffix = '\n'; // Default newline after block
            if (blockInfo.insertLine < document.lineCount) {
                const nextLine = document.lineAt(blockInfo.insertLine).text;
                if (nextLine.trim() !== '') {
                    suffix = '\n\n';
                }
            }

            const textToInsert = `${prefix}${importBlockText}${suffix}`;
            const pos = new vscode.Position(blockInfo.insertLine, 0);
            edit.insert(document.uri, pos, textToInsert);
        }
        return edit;
    }

    private getFQNFromDefinition(def: any, className: string): string {
        // Use the stored FQN if available (works for both src and vendor)
        if (def.fqn) {
            return def.fqn;
        }

        // Fallback for old index data: try to extract from path
        const pathParts = def.path.split('/');
        const srcIndex = pathParts.findIndex((p: string) => p === 'src');
        if (srcIndex !== -1) {
            const namespaceParts = pathParts.slice(srcIndex + 1, -1);
            const namespace = namespaceParts.join('\\');
            return namespace ? `${namespace}\\${className}` : className;
        }

        // Vendor fallback: Try to guess based on PSR-4 standard structure
        // structure: vendor/vendor-name/package-name/src/Path/To/Class.php
        // or: vendor/vendor-name/package-name/Path/To/Class.php
        const vendorIndex = pathParts.lastIndexOf('vendor');
        if (vendorIndex !== -1) {
            // This is a heuristic and might fail for complex mapping, but better than nothing
            // Try to find a folder that looks like a namespace root (often 'src' or 'lib')
            let startParts = vendorIndex + 3; // Skip vendor/pkg/name

            // Check if there is a 'src' or 'lib' folder
            if (pathParts[startParts] === 'src' || pathParts[startParts] === 'lib') {
                startParts++;
            }

            const namespaceParts = pathParts.slice(startParts, -1);
            const namespace = namespaceParts.join('\\');

            // This is tricky without composer.json mapping, but let's try
            // If we have "Symfony\Component\HttpFoundation", the path is often .../symfony/http-foundation/Request.php
            // We can return just the class name if unsure, causing the user to manually fix it, 
            // BUT the indexer SHOULD have the FQN now.

            // If FQN is missing, it means the index is stale or parser failed to get namespace.
            if (namespace) return `${namespace}\\${className}`;
        }

        // Last resort: return the class name alone
        return className;
    }

    private getImportBlockInfo(document: vscode.TextDocument): {
        range: vscode.Range | null,
        imports: string[],
        insertLine: number
    } {
        let firstUseLine = -1;
        let lastUseLine = -1;
        const imports: Set<string> = new Set();
        let namespaceLine = -1;
        let range: vscode.Range | null = null;

        // Scan document
        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const trimmed = lineText.trim();

            // Track namespace for fallback insertion
            if (trimmed.match(/^namespace\s+[^;]+;/)) {
                namespaceLine = i;
                continue;
            }

            // Track use statements (robust regex: starts with use, ends with ;)
            // Handles 'use Foo\Bar;' or 'use Foo\Bar as Baz;' case-insensitively
            const useMatch = trimmed.match(/^use\s+([^;]+);/i);
            if (useMatch) {
                // Normalize: "use Foo\Bar;"
                // We store the clean version to ensure formatting consistency
                let cleanImport = trimmed.split(';')[0].trim();
                // Ensure 'use' is lowercase for consistency
                if (cleanImport.toLowerCase().startsWith('use ')) {
                    cleanImport = 'use ' + cleanImport.substring(4);
                }
                imports.add(cleanImport + ';');

                if (firstUseLine === -1) firstUseLine = i;
                lastUseLine = i;
            } else if (
                trimmed.match(/^(?:abstract\s+|final\s+)?class\s+/) ||
                trimmed.match(/^(?:abstract\s+|final\s+)?interface\s+/) ||
                trimmed.match(/^trait\s+/) ||
                trimmed.match(/^enum\s+/)
            ) {
                // Stop scanning if we hit code (class/interface/trait/enum definition)
                if (imports.size > 0) break;
            } else if (trimmed === '' && firstUseLine !== -1) {
                // If we see a blank line AFTER finding the first use, we extend the lastUseLine 
                // temporarily to include potential gaps, BUT we must be careful.
                // Actually, standard behavior is to replace the whole block including gaps.
                // So we update lastUseLine to include this blank line if it's potentially part of the block.
                lastUseLine = i;
            }
        }

        // Determine insertion point if no block exists
        let insertLine = 0;
        if (namespaceLine !== -1) {
            insertLine = namespaceLine + 1;
        } else {
            // Check for <?php
            for (let i = 0; i < document.lineCount; i++) {
                if (document.lineAt(i).text.includes('<?php')) {
                    insertLine = i + 1;
                    break;
                }
            }
        }

        if (firstUseLine !== -1 && lastUseLine !== -1) {
            // Trim trailing blank lines from the captured range if the loop went too far
            // (e.g. captured blank lines before class definition)
            // We want the range to end at the last ACTUAL import
            // Recalculate lastUseLine based on content if needed, but the loop above extends eagerly.
            // Actually, extending the range to cover gaps IS what fixes the double imports/gaps.
            // But we need to make sure we don't eat the blank line before the class if we want to preserve ONE.

            // Let's refine: The range should perform a "Clean Replace".
            range = new vscode.Range(firstUseLine, 0, lastUseLine, document.lineAt(lastUseLine).text.length);
        }

        return { range, imports: Array.from(imports), insertLine };
    }
}

