const { Engine } = require('php-parser');

const parser = new Engine({
    parser: { extractDoc: true },
    ast: { withPositions: true }
});

const code = `<?php
namespace App;
use Symfony\\Bundle\\FrameworkBundle\\Kernel\\MicroKernelTrait;
use Symfony\\Component\\HttpKernel\\Kernel as BaseKernel;

class Kernel extends BaseKernel
{
    use MicroKernelTrait;
}
`;

const ast = parser.parseCode(code, 'test.php');
const imports = new Set();
const importedFQNs = new Map();

const collectImports = (nodes) => {
    if (!nodes) return;
    for (const node of nodes) {
        if (node.kind === 'namespace') {
            if (node.children) collectImports(node.children);
        } else if (node.kind === 'usegroup') {
            for (const item of node.items) {
                const fqn = item.name;
                let shortName = fqn.split('\\').pop();

                // FIX LOGIC HERE
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

console.log('Imports detected:', Array.from(imports));

if (imports.has('BaseKernel')) {
    console.log('SUCCESS: BaseKernel was detected as an import.');
} else {
    console.error('FAILURE: BaseKernel was NOT detected.');
    process.exit(1);
}
