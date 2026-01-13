import * as fs from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';

interface ComposerJson {
    autoload?: {
        "psr-4"?: { [key: string]: string | string[] };
    };
    "autoload-dev"?: {
        "psr-4"?: { [key: string]: string | string[] };
    };
}

export async function getNamespaceFromPath(filePath: string): Promise<string | null> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!workspaceFolder) {
        return null; // Not in workspace
    }

    const composerPath = path.join(workspaceFolder.uri.fsPath, 'composer.json');
    if (!await fs.pathExists(composerPath)) {
        return null; // No composer.json
    }

    try {
        const composer = await fs.readJson(composerPath) as ComposerJson;
        // Merge autoload and autoload-dev
        const autoloads = {
            ...(composer.autoload?.['psr-4'] || {}),
            ...(composer['autoload-dev']?.['psr-4'] || {})
        };

        // Normalize file path relative to workspace root
        // Force forward slashes for comparison standard
        const toUnix = (p: string) => p.split(path.sep).join('/');

        let relPath = path.relative(workspaceFolder.uri.fsPath, filePath);
        relPath = toUnix(relPath);

        // Remove filename to get directory path
        let relativeDir = toUnix(path.dirname(relPath));

        // Find best match in autoload
        let bestMatchNamespace = '';
        let bestMatchLength = 0;

        for (const [namespace, paths] of Object.entries(autoloads)) {
            const pathArray = Array.isArray(paths) ? paths : [paths];

            for (const p of pathArray) {
                // Normalize autoload path: remove trailing slash, force unix
                // "app/src/" -> "app/src"
                const normalizedPrefix = toUnix(p).replace(/\/$/, '');

                // Check if relativeDir STARTS with this prefix
                // e.g. relativeDir = "app/src/Controller", prefix = "app/src"
                // Need to ensure boundary check (e.g. prefix "app" shouldn't match "apple")
                // Check regex or simple 'startsWith' + separator check

                if (relativeDir === normalizedPrefix || relativeDir.startsWith(normalizedPrefix + '/')) {
                    if (normalizedPrefix.length >= bestMatchLength) {
                        // Wait, empty prefix "" (for "src") usually length 0.
                        // But if we have "src" and "src/App", length matters.
                        // Use prefix length.

                        bestMatchLength = normalizedPrefix.length;

                        // Calculate sub-namespace
                        // prefix: "app/src" (7)
                        // dir: "app/src/Controller" (18)
                        // sub: "/Controller" -> "Controller"

                        let subPath = relativeDir.substring(normalizedPrefix.length);
                        // Trim leading slash
                        subPath = subPath.replace(/^\//, '');

                        // Convert / to \ for Namespace
                        const subNamespace = subPath.split('/').join('\\');

                        bestMatchNamespace = namespace + subNamespace;
                    }
                }
            }
        }

        // Cleanup trailing backslashes
        return bestMatchNamespace.replace(/\\$/, '');

    } catch (e) {
        console.error("Error reading composer.json", e);
        return null;
    }
}
