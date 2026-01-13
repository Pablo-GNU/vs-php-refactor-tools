
const lines = [
    "<?php",
    "",
    "declare(strict_types=1);",
    "",
    "namespace Code\\App\\Controller\\ExampleBC\\ExampleModule;",
    "",
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
            continue;
        }

        const useMatch = trimmed.match(/^use\s+([^;]+);/);

        console.log(`Line ${i}: "${trimmed}" -> Match: ${useMatch ? 'YES' : 'NO'}`);

        if (useMatch) {
            imports.add(trimmed.split(';')[0] + ';');
            if (firstUseLine === -1) firstUseLine = i;
            lastUseLine = i;
        } else if (trimmed.startsWith('class ') || trimmed.startsWith('interface ') || trimmed.startsWith('trait ')) {
            if (imports.size > 0) break;
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
