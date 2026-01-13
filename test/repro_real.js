
const lines = [
    "<?php",
    "",
    "declare(strict_types=1);",
    "",
    "namespace Code\\App\\Controller\\ExampleBC\\ExampleModule;",
    "",
    "use Code\\App\\Controller\\BaseController;",
    "",
    "use Code\\ExampleBC\\ExampleModule\\Application\\Create\\CreateExampleCommand;",
    "use Code\\ExampleBC\\ExampleModule\\Application\\Search\\SearchExampleQuery;",
    "use Symfony\\Component\\HttpFoundation\\Request;",
    "use Symfony\\Component\\HttpFoundation\\Response;",
    "",
    "class AsunController extends BaseController",
    "{"
];

function getImportBlockInfo(documentLines) {
    let firstUseLine = -1;
    let lastUseLine = -1;
    const imports = new Set();
    let namespaceLine = -1;

    for (let i = 0; i < documentLines.length; i++) {
        const lineText = documentLines[i];
        const trimmed = lineText.trim();

        if (trimmed.match(/^namespace\s+[^;]+;/)) {
            namespaceLine = i;
            // continue; // Logic in actual code continues here
        }

        const useMatch = trimmed.match(/^use\s+([^;]+);/i);

        if (useMatch) {
            let cleanImport = trimmed.split(';')[0].trim();
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
            if (imports.size > 0) break;
        } else if (trimmed === '' && firstUseLine !== -1) {
            lastUseLine = i;
        }
    }

    return {
        firstUseLine,
        lastUseLine,
        imports: Array.from(imports),
        count: imports.size
    };
}

const result = getImportBlockInfo(lines);
console.log(JSON.stringify(result, null, 2));
