import * as vscode from 'vscode';
import { Indexer } from './indexer';

export class PhpReferenceProvider implements vscode.ReferenceProvider {
    private indexer: Indexer;
    private outputChannel: vscode.OutputChannel;

    constructor(indexer: Indexer, outputChannel: vscode.OutputChannel) {
        this.indexer = indexer;
        this.outputChannel = outputChannel;
    }

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const range = document.getWordRangeAtPosition(position);
        if (!range) return [];

        const word = document.getText(range);
        this.outputChannel.appendLine(`[RefProvider] Finding references for: ${word}`);

        const locations: vscode.Location[] = [];

        // Check if it's a method call by looking at surrounding context
        const lineText = document.lineAt(position.line).text;
        const isMethodCall = lineText.includes('->') || lineText.includes('::');

        if (isMethodCall) {
            // Try to find the class context
            // This is simplified - in reality, we'd need full AST analysis
            // For now, we'll search for method usages across all files
            const candidates = this.indexer.getCandidates(word);

            for (const candidatePath of candidates) {
                try {
                    const uri = vscode.Uri.parse(candidatePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const text = doc.getText();

                    // Simple regex to find method calls
                    const methodCallPattern = new RegExp(`->\\s*${word}\\s*\\(|::\\s*${word}\\s*\\(`, 'g');
                    let match;

                    while ((match = methodCallPattern.exec(text)) !== null) {
                        const pos = doc.positionAt(match.index);
                        const wordRange = doc.getWordRangeAtPosition(pos.translate(0, match[0].indexOf(word)));
                        if (wordRange) {
                            locations.push(new vscode.Location(uri, wordRange));
                        }
                    }
                } catch (e) {
                    console.error(`Error processing ${candidatePath}:`, e);
                }
            }
        } else {
            // It's a class/interface/trait reference
            const candidates = this.indexer.getCandidates(word);

            for (const candidatePath of candidates) {
                try {
                    const uri = vscode.Uri.parse(candidatePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const text = doc.getText();

                    // Find occurrences of the class name
                    const pattern = new RegExp(`\\b${word}\\b`, 'g');
                    let match;

                    while ((match = pattern.exec(text)) !== null) {
                        const pos = doc.positionAt(match.index);
                        const wordRange = doc.getWordRangeAtPosition(pos);
                        if (wordRange) {
                            locations.push(new vscode.Location(uri, wordRange));
                        }
                    }
                } catch (e) {
                    console.error(`Error processing ${candidatePath}:`, e);
                }
            }
        }

        this.outputChannel.appendLine(`[RefProvider] Found ${locations.length} references`);
        return locations;
    }
}
