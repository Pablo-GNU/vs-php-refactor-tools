import * as vscode from 'vscode';
import { Indexer } from './indexer';

export class PhpImplementationProvider implements vscode.ImplementationProvider {
    private indexer: Indexer;
    private outputChannel: vscode.OutputChannel;

    constructor(indexer: Indexer, outputChannel: vscode.OutputChannel) {
        this.indexer = indexer;
        this.outputChannel = outputChannel;
    }

    public async provideImplementation(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return [];

        const word = document.getText(range);
        this.outputChannel.appendLine(`[ImplProvider] Finding implementations for: ${word}`);

        const locations: vscode.Location[] = [];

        // Check if it's an interface
        const definitions = this.indexer.getDefinitions(word);
        const isInterface = definitions.some(def => def.kind === 'interface');

        if (isInterface) {
            // Find all classes that implement this interface
            const implementations = this.indexer.getImplementations(word);

            for (const className of implementations) {
                const classDefs = this.indexer.getDefinitions(className);
                for (const def of classDefs) {
                    if (def.range) {
                        const uri = vscode.Uri.file(def.path);
                        locations.push(new vscode.Location(uri, def.range));
                    }
                }
            }

            this.outputChannel.appendLine(`[ImplProvider] Found ${implementations.length} implementing classes`);
        } else {
            // Check if it's a method within an interface
            // Look at the current line to see if we're in an interface context
            const lineText = document.lineAt(position.line).text;

            // Try to find the parent class/interface
            // This requires parsing the current document
            // For simplicity, we'll check if the cursor is within an interface definition
            const text = document.getText();
            const offset = document.offsetAt(position);

            // Simple heuristic: find the interface block this position is in
            const beforeText = text.substring(0, offset);
            const interfaceMatch = beforeText.match(/interface\s+(\w+)/g);

            if (interfaceMatch && interfaceMatch.length > 0) {
                const lastInterfaceMatch = interfaceMatch[interfaceMatch.length - 1];
                const interfaceName = lastInterfaceMatch.replace('interface', '').trim();

                // Find implementations of this interface
                const implementations = this.indexer.getImplementations(interfaceName);

                for (const className of implementations) {
                    // Look for this method in the implementing class
                    const methodKey = `${className}::${word}`;
                    const methodDefs = this.indexer.getMethodDefinitions(methodKey);

                    for (const methodDef of methodDefs) {
                        if (methodDef.range) {
                            const uri = vscode.Uri.file(methodDef.path);
                            locations.push(new vscode.Location(uri, methodDef.range));
                        }
                    }
                }

                this.outputChannel.appendLine(`[ImplProvider] Found ${locations.length} method implementations`);
            }
        }

        return locations;
    }
}
