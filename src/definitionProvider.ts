import * as vscode from 'vscode';
import { Indexer } from './indexer';

export class PhpDefinitionProvider implements vscode.DefinitionProvider {
    private indexer: Indexer;
    private outputChannel: vscode.OutputChannel; // Log

    constructor(indexer: Indexer, outputChannel: vscode.OutputChannel) {
        this.indexer = indexer;
        this.outputChannel = outputChannel;
    }

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {

        const range = document.getWordRangeAtPosition(position);
        if (!range) return [];

        const word = document.getText(range);
        this.outputChannel.appendLine(`[DefProvider] Looking up definition for: ${word}`);

        // Check if this is a method call
        const lineText = document.lineAt(position.line).text;
        const lineBeforeCursor = lineText.substring(0, range.start.character);

        // Check for -> or :: before the word
        const isMethodCall = /(?:->|::)\s*$/.test(lineBeforeCursor);

        if (isMethodCall) {
            this.outputChannel.appendLine(`[DefProvider] Detected method call context`);

            // Try to find the class by looking backwards for the variable/class name
            const beforeMethod = lineBeforeCursor.match(/(\$\w+|\w+)\s*(?:->|::)\s*$/);
            if (beforeMethod) {
                const classOrVar = beforeMethod[1];
                this.outputChannel.appendLine(`[DefProvider] Looking for method ${word} in context of ${classOrVar}`);

                // For now, search all class::method combinations
                // A more sophisticated implementation would resolve the variable type
                const allMethodKeys = Array.from(this.indexer['methods'].keys());
                const matchingMethods = allMethodKeys.filter(key => key.endsWith(`::${word}`));

                this.outputChannel.appendLine(`[DefProvider] Found ${matchingMethods.length} matching methods: ${matchingMethods.join(', ')}`);

                const locations: vscode.Location[] = [];
                for (const methodKey of matchingMethods) {
                    const methodDefs = this.indexer.getMethodDefinitions(methodKey);
                    for (const def of methodDefs) {
                        this.outputChannel.appendLine(`[DefProvider] Adding method definition: ${def.path}`);
                        const uri = vscode.Uri.file(def.path);
                        const defRange = def.range || new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
                        locations.push(new vscode.Location(uri, defRange));
                    }
                }

                if (locations.length > 0) {
                    return locations;
                }
            }
        }

        // Fast Lookup via Indexer Definitions (for classes/interfaces/traits)
        const definitions = this.indexer.getDefinitions(word);
        this.outputChannel.appendLine(`[DefProvider] Definitions found: ${definitions.length}`);

        if (definitions.length === 0) {
            return [];
        }

        const locations: vscode.Location[] = [];
        for (const def of definitions) {
            this.outputChannel.appendLine(`[DefProvider] Returning match: ${def.path}`);
            const uri = vscode.Uri.file(def.path);
            const defRange = def.range || new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
            locations.push(new vscode.Location(uri, defRange));
        }

        return locations;
    }
}
