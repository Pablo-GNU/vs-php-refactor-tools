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

const findUseGroups = (nodes) => {
    if (!nodes) return;
    for (const node of nodes) {
        if (node.kind === 'namespace') {
            findUseGroups(node.children);
        } else if (node.kind === 'usegroup') {
            console.log('UseGroup found:');
            console.log(JSON.stringify(node, null, 2));
        } else if (node.children) {
            findUseGroups(node.children);
        }
    }
};

findUseGroups(ast.children);
