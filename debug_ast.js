const parser = require('php-parser');

const code = `<?php
$command = new SearchExampleQuery('a');
$command->id();
`;

const p = new parser.Engine({
    parser: {
        extractDoc: true,
        php7: true
    },
    ast: {
        withPositions: true
    }
});

const ast = p.parseCode(code);
console.log(JSON.stringify(ast, null, 2));
