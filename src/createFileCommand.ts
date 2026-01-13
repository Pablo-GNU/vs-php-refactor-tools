import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { getNamespaceFromPath } from './psr4';
import { Indexer, SymbolDef } from './indexer';

export async function createPhpFile(uri: vscode.Uri, indexer: Indexer) {
    if (!uri || !uri.fsPath) {
        return vscode.window.showErrorMessage("Please use this command from the File Explorer context menu on a folder.");
    }

    // 1. Ask Name
    const name = await vscode.window.showInputBox({
        placeHolder: 'Name (e.g. MyService)',
        validateInput: (text) => {
            if (!/^[A-Z][a-zA-Z0-9]*$/.test(text)) {
                return "Name must start with uppercase and be alphanumeric.";
            }
            return null;
        }
    });
    if (!name) return;

    // 2. Ask Type
    const type = await vscode.window.showQuickPick(
        ['Class', 'Interface', 'Trait', 'Abstract Class', 'Final Class'],
        { placeHolder: 'Select file type' }
    );
    if (!type) return;

    // 3. Ask Strict Types
    const useStrictRaw = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Add declare(strict_types=1)?' });
    if (!useStrictRaw) return;
    const useStrict = useStrictRaw === 'Yes';

    // 4. Extends / Implements
    let extendsDef: SymbolDef | undefined;
    let implementsDefs: SymbolDef[] = [];

    const allClasses = indexer.getSymbolsByKind(['class']);
    const allInterfaces = indexer.getSymbolsByKind(['interface']);

    // Helper to map symbols to QuickPick items
    // Store full SymbolDef in a map or find it back? 
    // QuickPickItem can hold custom data? No, stuck with string properties unless custom interface.
    // Let's just find by path + name matches or use a lookup.

    interface SymbolItem extends vscode.QuickPickItem {
        symbol: SymbolDef;
    }

    const toItems = (symbols: SymbolDef[]): SymbolItem[] => symbols.map(s => ({
        label: s.name,
        description: '',
        detail: vscode.workspace.asRelativePath(s.path),
        symbol: s
    })).sort((a, b) => a.label.localeCompare(b.label));

    if (type.includes('Class')) {
        // Extends (Single, Optional) - Only Classes
        const pickedExtends = await vscode.window.showQuickPick<SymbolItem>(
            toItems(allClasses),
            { placeHolder: '(Optional) Extends: Select or Escape to skip' }
        );
        if (pickedExtends) extendsDef = pickedExtends.symbol;

        // Implements (Multi, Optional) - Only Interfaces
        const pickedImplements = await vscode.window.showQuickPick<SymbolItem>(
            toItems(allInterfaces),
            { placeHolder: '(Optional) Implements: Select one or more', canPickMany: true }
        );
        if (pickedImplements) implementsDefs = pickedImplements.map(i => i.symbol);
    }
    else if (type === 'Interface') {
        const pickedExtends = await vscode.window.showQuickPick<SymbolItem>(
            toItems(allInterfaces),
            { placeHolder: '(Optional) Extends: Select one or more', canPickMany: true }
        );
        // PHP Interfaces can extend multiple interfaces
        if (pickedExtends) implementsDefs = pickedExtends.map(i => i.symbol); // We reuse implementsDefs variable for list but semantic is 'extends'
    }

    // 5. Generate
    const targetFilePath = path.join(uri.fsPath, `${name}.php`);
    const namespace = await getNamespaceFromPath(targetFilePath);

    let content = "<?php\n\n";
    if (useStrict) {
        content = "<?php\n\ndeclare(strict_types=1);\n\n";
    }

    if (namespace) {
        content += `namespace ${namespace};\n\n`;
    }

    // Resolve FQNs for Imports
    const imports = new Set<string>();

    const resolveAndAdd = async (def: SymbolDef) => {
        const ns = await getNamespaceFromPath(def.path);
        // Important: If ns is null (global) and namespace is not null, we probably need use Global\Name? 
        // Or if ns is same as current namespace, SKIP.
        if (ns && ns !== namespace) {
            imports.add(`${ns}\\${def.name}`);
        }
    };

    if (extendsDef) await resolveAndAdd(extendsDef);
    for (const def of implementsDefs) await resolveAndAdd(def);

    if (imports.size > 0) {
        Array.from(imports).sort().forEach(i => content += `use ${i};\n`);
        content += "\n";
    }

    // Definition Header
    if (type === 'Final Class') content += "final ";
    if (type === 'Abstract Class') content += "abstract ";

    if (type.includes('Interface')) {
        content += `interface ${name}`;
        if (implementsDefs.length > 0) content += ` extends ${implementsDefs.map(d => d.name).join(', ')}`;
    } else if (type === 'Trait') {
        content += `trait ${name}`;
    } else {
        content += `class ${name}`;
        if (extendsDef) content += ` extends ${extendsDef.name}`;
        if (implementsDefs.length > 0) content += ` implements ${implementsDefs.map(d => d.name).join(', ')}`;
    }

    content += "\n{\n    //\n}\n";

    await fs.writeFile(targetFilePath, content);

    const doc = await vscode.workspace.openTextDocument(targetFilePath);
    await vscode.window.showTextDocument(doc);
}
