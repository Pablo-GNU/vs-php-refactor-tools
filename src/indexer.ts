import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
// @ts-ignore
import { Engine } from 'php-parser';

export interface SymbolDef {
    name: string;
    path: string;
    kind: 'class' | 'interface' | 'trait' | 'method';
    range?: vscode.Range;
    parent?: string; // For methods: the class/interface/trait name
    fqn?: string; // Fully Qualified Name (e.g., Symfony\Component\HttpFoundation\Request)
}

export interface InheritanceInfo {
    className: string;
    extends?: string;
    implements: string[];
}

export class Indexer {
    // Map<SymbolName, Set<FileUriString>> - For Usage/References (Search)
    private index: Map<string, Set<string>> = new Map();

    // Map<SymbolName, SymbolDef[]> - For Definitions config (Wizard/Autocomplete)
    private definitions: Map<string, SymbolDef[]> = new Map();

    // Map<ClassName::method, SymbolDef[]> - For Method Definitions
    private methods: Map<string, SymbolDef[]> = new Map();

    // Map<ClassName, InheritanceInfo> - For Inheritance Relationships
    private inheritance: Map<string, InheritanceInfo> = new Map();

    private files: Set<string> = new Set(); // Track indexed files
    private parser: any;
    private isIndexing = false;
    private outputChannel?: vscode.OutputChannel;

    constructor(outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        this.parser = new Engine({
            parser: { extractDoc: true },
            ast: { withPositions: true }
        });
    }

    private log(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[Indexer] ${message}`);
        }
        console.log(`[Indexer] ${message}`);
    }

    public getCandidates(symbol: string): string[] {
        const files = this.index.get(symbol);
        return files ? Array.from(files) : [];
    }

    /**
     * Returns a flat list of symbols matching the requested kinds.
     */
    public getSymbolsByKind(kinds: ('class' | 'interface' | 'trait' | 'method')[]): SymbolDef[] {
        const result: SymbolDef[] = [];
        for (const defs of this.definitions.values()) {
            for (const def of defs) {
                if (kinds.includes(def.kind)) {
                    result.push(def);
                }
            }
        }
        return result;
    }

    private async scanDirRecursive(dir: string): Promise<vscode.Uri[]> {
        const results: vscode.Uri[] = [];
        const list = await fs.readdir(dir);

        for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = await fs.stat(filePath);

            if (stat && stat.isDirectory()) {
                // Optimization: Skip obviously non-php folders if needed, but vendor structure is predictable
                // Recursively scan
                const subResults = await this.scanDirRecursive(filePath);
                results.push(...subResults);
            } else if (file.endsWith('.php')) {
                results.push(vscode.Uri.file(filePath));
            }
        }
        return results;
    }

    public getDefinitions(name: string): SymbolDef[] {
        return this.definitions.get(name) || [];
    }

    public getMethodDefinitions(qualifiedName: string): SymbolDef[] {
        return this.methods.get(qualifiedName) || [];
    }

    public getInheritanceInfo(className: string): InheritanceInfo | undefined {
        return this.inheritance.get(className);
    }

    public getImplementations(interfaceName: string): string[] {
        const implementations: string[] = [];
        for (const [className, info] of this.inheritance.entries()) {
            if (info.implements.includes(interfaceName)) {
                implementations.push(className);
            }
        }
        return implementations;
    }

    public getAllSymbols(): string[] {
        return Array.from(this.index.keys());
    }

    public async scanWorkspace() {
        if (this.isIndexing) return;
        this.isIndexing = true;

        // Get exclusion configuration
        const config = vscode.workspace.getConfiguration('phpRefactorTools.indexer');
        const excludeVendor = config.get('excludeVendor', true);
        const excludeDirs = config.get('exclude', ['vendor', 'node_modules', 'storage', 'var']);

        // Build exclude pattern
        let excludePattern = '';
        if (excludeVendor) {
            excludePattern = `**/{${excludeDirs.join(',')}}/**`;
        } else {
            // Exclude all except vendor
            const nonVendorDirs = excludeDirs.filter((d: string) => d !== 'vendor');
            if (nonVendorDirs.length > 0) {
                excludePattern = `**/{${nonVendorDirs.join(',')}}/**`;
            }
        }

        // scanWorkspace implementation
        let files: vscode.Uri[] = [];
        this.files.clear(); // Reset stats

        // 1. Scan user files (Respects .gitignore)
        const userFiles = await vscode.workspace.findFiles('**/*.php', '**/{vendor,node_modules,storage,var}/**');
        files.push(...userFiles);

        // 2. Scan vendor files if enabled (Bypasses .gitignore)
        if (!excludeVendor) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
                const vendorPath = path.join(workspaceRoot, 'vendor');
                this.log(`Checking vendor path: ${vendorPath}`);

                if (await fs.pathExists(vendorPath)) {
                    vscode.window.setStatusBarMessage('Indexing vendor files (this may take a while)...');
                    this.log('Vendor directory found. Starting recursive scan...');
                    try {
                        const vendorFiles = await this.scanDirRecursive(vendorPath);
                        this.log(`Found ${vendorFiles.length} files in vendor.`);
                        files.push(...vendorFiles);
                    } catch (e) {
                        this.log(`Error scanning vendor: ${e}`);
                        console.error('Error scanning vendor:', e);
                    }
                } else {
                    this.log('Vendor directory NOT found at ' + vendorPath);
                }
            } else {
                this.log('No workspace root found.');
            }
        } else {
            this.log('Vendor indexing is DISABLED by configuration.');
        }

        if (files.length === 0) {
            this.isIndexing = false;
            return;
        }

        const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        status.text = `$(sync~spin) Indexing PHP: 0/${files.length}`;
        status.show();

        let count = 0;
        const start = Date.now();

        for (const uri of files) {
            try {
                if (Date.now() - start > 50) await new Promise(r => setTimeout(r, 0));
                await this.scanFile(uri);
            } catch (e) {
                console.error(`Failed to index ${uri.fsPath}`);
            }
            count++;
            if (count % 50 === 0) status.text = `$(sync~spin) Indexing PHP: ${count}/${files.length}`;
        }

        status.text = `$(check) PHP Indexing Complete`;
        setTimeout(() => status.dispose(), 3000);

        this.isIndexing = false;
        console.log(`[Indexer] Index built: ${this.index.size} usage symbols, ${this.definitions.size} definitions, ${this.methods.size} methods, ${this.inheritance.size} classes with inheritance`);
    }

    public async scanFile(uri: vscode.Uri) {
        try {
            this.files.add(uri.toString());
            const content = await fs.readFile(uri.fsPath, 'utf8');
            const ast = this.parser.parseCode(content, uri.fsPath);
            this.updateIndexForFile(uri.toString(), uri.fsPath, ast);
        } catch (e) { }
    }

    public removeFile(uri: vscode.Uri) {
        const uriStr = uri.toString();
        this.files.delete(uriStr);
        // Remove from usage index
        for (const files of this.index.values()) {
            files.delete(uriStr);
        }
        // Remove from definitions
        for (const [key, defs] of this.definitions.entries()) {
            const filtered = defs.filter(d => d.path !== uri.fsPath);
            if (filtered.length < defs.length) {
                this.definitions.set(key, filtered);
            }
        }
        // Remove from methods
        for (const [key, defs] of this.methods.entries()) {
            const filtered = defs.filter(d => d.path !== uri.fsPath);
            if (filtered.length < defs.length) {
                this.methods.set(key, filtered);
            }
        }
        // Remove from inheritance (classes defined in this file)
        for (const [className, info] of this.inheritance.entries()) {
            const classDefs = this.definitions.get(className);
            if (classDefs && classDefs.every(d => d.path === uri.fsPath)) {
                this.inheritance.delete(className);
            }
        }
    }

    public async rebuildIndex(): Promise<void> {
        // Clear all indexes
        this.index.clear();
        this.definitions.clear();
        this.methods.clear();
        this.inheritance.clear();

        // Rescan workspace
        await this.scanWorkspace();
    }

    private updateIndexForFile(uriStr: string, fsPath: string, ast: any) {
        this.removeFile(vscode.Uri.parse(uriStr));

        const symbolsFound = new Set<string>();
        let currentNamespace = ''; // Track namespace context

        const traverse = (nodes: any[]) => {
            if (!nodes) return;
            for (const node of nodes) {
                // Capture namespace
                if (node.kind === 'namespace') {
                    currentNamespace = node.name;
                }

                // Definitions
                if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
                    const name = typeof node.name === 'string' ? node.name : node.name.name;
                    symbolsFound.add(name);

                    // Add to Definitions
                    const defs = this.definitions.get(name) || [];

                    let range: vscode.Range | undefined;
                    if (node.loc) {
                        range = new vscode.Range(
                            new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
                            new vscode.Position(node.loc.end.line - 1, node.loc.end.column)
                        );
                    }

                    // Build FQN from current namespace context
                    let fqn = name;
                    if (currentNamespace) {
                        fqn = `${currentNamespace}\\${name}`;
                    }

                    defs.push({
                        name: name,
                        path: fsPath,
                        kind: node.kind,
                        range: range,
                        fqn: fqn
                    });
                    this.definitions.set(name, defs);

                    // Track Inheritance
                    const inheritanceInfo: InheritanceInfo = {
                        className: name,
                        implements: []
                    };

                    if (node.extends) {
                        const extName = typeof node.extends === 'string' ? node.extends :
                            (node.extends.name ? node.extends.name :
                                (typeof node.extends.name === 'string' ? node.extends.name : node.extends.name.name));
                        inheritanceInfo.extends = extName;
                    }

                    if (node.implements && Array.isArray(node.implements)) {
                        for (const impl of node.implements) {
                            const implName = typeof impl === 'string' ? impl : (impl.name || impl.name?.name);
                            if (implName) {
                                inheritanceInfo.implements.push(implName);
                            }
                        }
                    }

                    this.inheritance.set(name, inheritanceInfo);

                    // Track Methods within this class/interface/trait
                    const traverseBody = (bodyNodes: any[]) => {
                        if (!bodyNodes) return;
                        for (const bodyNode of bodyNodes) {
                            if (bodyNode.kind === 'method') {
                                const methodName = typeof bodyNode.name === 'string' ? bodyNode.name : bodyNode.name.name;
                                const qualifiedName = `${name}::${methodName}`;

                                let methodRange: vscode.Range | undefined;
                                if (bodyNode.loc) {
                                    methodRange = new vscode.Range(
                                        new vscode.Position(bodyNode.loc.start.line - 1, bodyNode.loc.start.column),
                                        new vscode.Position(bodyNode.loc.end.line - 1, bodyNode.loc.end.column)
                                    );
                                }

                                const methodDefs = this.methods.get(qualifiedName) || [];
                                methodDefs.push({
                                    name: methodName,
                                    path: fsPath,
                                    kind: 'method',
                                    range: methodRange,
                                    parent: name
                                });
                                this.methods.set(qualifiedName, methodDefs);
                            }
                        }
                    };

                    if (node.body) {
                        if (Array.isArray(node.body)) {
                            traverseBody(node.body);
                        } else if (node.body.children) {
                            traverseBody(node.body.children);
                        }
                    }
                }

                // Usages
                else if (node.kind === 'usegroup') {
                    for (const item of node.items) {
                        const parts = item.name.split('\\');
                        symbolsFound.add(parts[parts.length - 1]);
                    }
                }
                else if (node.kind === 'name') {
                    const parts = node.name.split('\\');
                    symbolsFound.add(parts[parts.length - 1]);
                }

                if (node.children) traverse(node.children);
                if (node.body) {
                    if (Array.isArray(node.body)) traverse(node.body);
                    else if (node.body.children) traverse(node.body.children);
                }
            }
        };

        if (ast.children) traverse(ast.children);

        // Update Usage Index
        for (const symbol of symbolsFound) {
            if (!this.index.has(symbol)) this.index.set(symbol, new Set());
            this.index.get(symbol)!.add(uriStr);
        }
    }

    public getStats() {
        return {
            files: this.files.size,
            symbols: this.index.size
        };
    }
}
