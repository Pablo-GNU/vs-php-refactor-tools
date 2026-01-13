import * as vscode from 'vscode';
import { Indexer } from './indexer';
// @ts-ignore
import { Engine } from 'php-parser';

export class PhpImportDiagnostics {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private indexer: Indexer;
    private parser: any;

    constructor(indexer: Indexer) {
        this.indexer = indexer;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('php-imports');
        this.parser = new Engine({
            parser: { extractDoc: true },
            ast: { withPositions: true }
        });
    }

    public getDiagnosticCollection(): vscode.DiagnosticCollection {
        return this.diagnosticCollection;
    }

    public async updateDiagnostics(document: vscode.TextDocument) {
        if (document.languageId !== 'php') {
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();

        let ast;
        try {
            ast = this.parser.parseCode(text, document.uri.fsPath);
        } catch (e) {
            // If parse fails, clear diagnostics
            this.diagnosticCollection.set(document.uri, []);
            return;
        }

        // Collect imported classes
        const imports = new Set<string>();
        const importedFQNs = new Map<string, string>(); // shortName -> FQN

        // Collect namespace
        let currentNamespace = '';

        const collectImports = (nodes: any[]) => {
            if (!nodes) return;
            for (const node of nodes) {
                if (node.kind === 'namespace') {
                    currentNamespace = node.name;
                    if (node.children) collectImports(node.children);
                } else if (node.kind === 'usegroup') {
                    for (const item of node.items) {
                        const fqn = item.name;
                        let shortName = fqn.split('\\').pop();

                        // Handle aliases (use Foo as Bar)
                        if (item.alias && item.alias.name) {
                            shortName = item.alias.name;
                        }

                        imports.add(shortName);
                        importedFQNs.set(shortName, fqn);
                    }
                } else if (node.children) {
                    collectImports(node.children);
                }
            }
        };
        collectImports(ast.children);

        // Find class usages
        const usedClasses = new Set<{ name: string, loc: any }>();

        const findClassUsages = (nodes: any[]) => {
            if (!nodes) return;
            for (const node of nodes) {
                // Type hints in parameters
                if (node.kind === 'parameter' && node.type && node.type.name) {
                    const typeName = node.type.name;
                    if (typeof typeName === 'string' && !this.isBuiltInType(typeName)) {
                        usedClasses.add({ name: typeName, loc: node.type.loc });
                    }
                }

                // Return type hints
                if (node.kind === 'method') {
                    // console.log('Inspecting method:', node.name, 'Keys:', Object.keys(node));
                    if (node.arguments) {
                        // console.log('Method has arguments:', node.arguments);
                    }
                }
                if (node.kind === 'method' && node.type && node.type.name) {
                    const typeName = node.type.name;
                    if (typeof typeName === 'string' && !this.isBuiltInType(typeName)) {
                        usedClasses.add({ name: typeName, loc: node.type.loc });
                    }
                }

                // Class instantiation (new ClassName)
                if (node.kind === 'new' && node.what && node.what.name) {
                    const className = node.what.name;
                    if (typeof className === 'string') {
                        usedClasses.add({ name: className, loc: node.what.loc });
                    }
                }

                // Static calls (ClassName::method)
                if (node.kind === 'staticlookup' && node.what && node.what.name) {
                    const className = node.what.name;
                    if (typeof className === 'string' && className !== 'self' && className !== 'parent' && className !== 'static') {
                        usedClasses.add({ name: className, loc: node.what.loc });
                    }
                }

                // Extends/Implements
                if ((node.kind === 'class' || node.kind === 'interface') && node.extends) {
                    const extName = node.extends.name || node.extends;
                    if (typeof extName === 'string') {
                        usedClasses.add({ name: extName, loc: node.extends.loc || node.loc });
                    }
                }

                if (node.kind === 'class' && node.implements) {
                    for (const impl of node.implements) {
                        const implName = impl.name || impl;
                        if (typeof implName === 'string') {
                            usedClasses.add({ name: implName, loc: impl.loc || node.loc });
                        }
                    }
                }

                if (node.kind === 'property' && node.type && node.type.name) {
                    const typeName = node.type.name;
                    if (typeof typeName === 'string' && !this.isBuiltInType(typeName)) {
                        usedClasses.add({ name: typeName, loc: node.type.loc });
                    }
                }

                if (node.children) findClassUsages(node.children);
                if (node.arguments) findClassUsages(node.arguments);
                if (node.parameters) findClassUsages(node.parameters); // Add parameters support just in case
                if (node.body) {
                    if (Array.isArray(node.body)) findClassUsages(node.body);
                    else if (node.body.children) findClassUsages(node.body.children);
                }
            }
        };
        findClassUsages(ast.children);

        // Check each used class
        for (const { name, loc } of usedClasses) {
            // Skip if already imported
            if (imports.has(name)) {
                continue;
            }

            // Skip if it's in the same namespace
            // Skip if it's in the same namespace
            const definitions = this.indexer.getDefinitions(name);
            const expectedFQN = currentNamespace ? `${currentNamespace}\\${name}` : name;

            const inSameNamespace = definitions.some(def => {
                // Use FQN if available (from new indexer)
                if (def.fqn) {
                    return def.fqn === expectedFQN;
                }
                // Fallback: simple path check (less accurate)
                return def.path.includes(currentNamespace.replace(/\\/g, '/'));
            });

            if (inSameNamespace) {
                continue;
            }

            // Create diagnostic
            if (loc) {
                const range = new vscode.Range(
                    new vscode.Position(loc.start.line - 1, loc.start.column),
                    new vscode.Position(loc.end.line - 1, loc.end.column)
                );

                const diagnostic = new vscode.Diagnostic(
                    range,
                    `Class '${name}' is not imported. Add 'use' statement.`,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = 'missing-import';
                diagnostic.source = 'php-tools';

                diagnostics.push(diagnostic);
            }
        }

        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    private isBuiltInType(type: string): boolean {
        const builtIns = ['int', 'string', 'bool', 'float', 'array', 'object', 'callable', 'iterable', 'void', 'mixed', 'never', 'null', 'true', 'false'];
        return builtIns.includes(type.toLowerCase());
    }

    public clear(document: vscode.TextDocument) {
        this.diagnosticCollection.delete(document.uri);
    }

    public dispose() {
        this.diagnosticCollection.dispose();
    }
}
