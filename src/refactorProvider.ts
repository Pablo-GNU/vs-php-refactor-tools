import * as vscode from 'vscode';
// @ts-ignore
import { Engine } from 'php-parser';

export class PhpRefactorCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.Refactor
    ];

    private parser = new Engine({
        parser: { extractDoc: true },
        ast: { withPositions: true }
    });

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {

        if (document.languageId !== 'php') {
            return;
        }

        const actions: vscode.CodeAction[] = [];

        // Parse simple AST to check if cursor is on a class
        // We can optimize this by only parsing if range is small or using indexer, 
        // but for now let's do a quick regex check first to see if we are near 'class X'
        // or parse the file if it's not huge.

        // Optimization: Get the word at cursor
        const wordRange = document.getWordRangeAtPosition(range.start);
        if (!wordRange) return;

        const word = document.getText(wordRange);
        const lineText = document.lineAt(range.start.line).text;

        // Simple heuristic: if line contains "class Word" or "interface Word"
        if (/\b(class|interface|trait)\s+/.test(lineText) && lineText.includes(word)) { // Simplified check
            const action = new vscode.CodeAction('Rename Class', vscode.CodeActionKind.RefactorRewrite);
            action.command = {
                command: 'vs-php-refactor-tools.renameClass',
                title: 'Rename Class',
                arguments: [document.uri, word]
            };
            actions.push(action);
        }

        // Check for Method Definition or Call
        // Definitions: "function methodName"
        // Calls: "->methodName" or "::methodName"
        const isMethodDef = /\bfunction\s+/.test(lineText) && lineText.includes(word);
        const isMethodCall = /(?:->|::)\s*$/.test(lineText.substring(0, range.start.character)) || lineText.includes(`->${word}`) || lineText.includes(`::${word}`);

        if (isMethodDef || isMethodCall) {
            const action = new vscode.CodeAction('Rename Method', vscode.CodeActionKind.RefactorRewrite);
            action.command = {
                command: 'vs-php-refactor-tools.renameMethod',
                title: 'Rename Method',
                arguments: [document.uri, word, range] // Pass range to help identify context
            };
            actions.push(action);
        }

        return actions;
    }
}
