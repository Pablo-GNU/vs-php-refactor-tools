
// Mock vscode module before importing anything that uses it
const path = require('path');
const fs = require('fs-extra');

// Setup test environment
const TEST_DIR = path.resolve(__dirname, '../ws-test');
fs.ensureDirSync(TEST_DIR);

// Mock vscode globally for the test process
const vscodeMock = require('vscode');
vscodeMock.workspace.workspaceFolders = [{ uri: vscodeMock.Uri.file(TEST_DIR) }];

// Import our logic (JS port for verification)
const { handleFileRename } = require('./refactor-logic');

async function runTest() {
    console.log("Setting up test workspace...");

    // 1. Create composer.json
    const composerJson = {
        autoload: {
            "psr-4": {
                "App\\": "src/"
            }
        }
    };
    await fs.writeJson(path.join(TEST_DIR, 'composer.json'), composerJson);

    // 2. Create Old file structure
    const oldPath = path.join(TEST_DIR, 'src/Services/OldService.php');
    await fs.ensureDir(path.dirname(oldPath));
    // We don't strictly need the old file on disk for the logic to work if we pass the URIs correctly?
    // Logic: 
    //   getNamespaceFromPath(oldUri) works on URI string.
    //   getNamespaceFromPath(newUri) works on URI string.
    //   BUT handleFileRename reads the NEW file from disk to parse it. 'vscode.workspace.openTextDocument(newUri)'

    // So we need the NEW file on disk.
    const newPath = path.join(TEST_DIR, 'src/Utils/OldService.php');
    await fs.ensureDir(path.dirname(newPath));

    const fileContent = `<?php
namespace App\\Services;

class OldService {
    public function sayHello() {
        echo "Hello";
    }
}
`;
    await fs.writeFile(newPath, fileContent);

    // 3. Create a referencing file
    const refPath = path.join(TEST_DIR, 'src/Controller/MyController.php');
    await fs.ensureDir(path.dirname(refPath));
    const refContent = `<?php
namespace App\\Controller;

use App\\Services\\OldService;

class MyController {
    public function index() {
        $service = new OldService();
        $service->sayHello();
    }
}
`;
    await fs.writeFile(refPath, refContent);

    console.log("Files created.");

    // 4. Simulate Rename Event
    const event = {
        files: [
            {
                oldUri: vscodeMock.Uri.file(oldPath),
                newUri: vscodeMock.Uri.file(newPath)
            }
        ]
    };

    console.log("Triggering handleFileRename...");
    await handleFileRename(event);

    // 5. Verify Edits
    const lastEdit = vscodeMock.workspace.lastEdit;

    if (!lastEdit) {
        console.error("FAIL: No edits were applied!");
        process.exit(1);
    }

    console.log("Edits captured:", lastEdit.edits.length);

    // Check edit 1: Namespace update in OldService.php
    const fileEdit = lastEdit.edits.find(e => e.uri.fsPath === newPath);
    if (!fileEdit) {
        console.error("FAIL: No edit for moved file.");
        process.exit(1);
    }
    if (fileEdit.newText.includes('namespace App\\Utils;')) {
        console.log("PASS: Namespace updated correctly.");
    } else {
        console.error("FAIL: Namespace incorrect.", fileEdit.newText);
        process.exit(1);
    }

    // Check edit 2: Reference update in MyController.php
    const refEdit = lastEdit.edits.find(e => e.uri.fsPath === refPath);
    if (!refEdit) {
        console.error("FAIL: No edit for referencing file.");
        process.exit(1);
    }
    // We expect "use App\Services\OldService;" -> "use App\Utils\OldService;"
    // Note: Our logic replaces specific ranges. 
    // The captured edit.newText should be the REPLACEMENT string.
    // In our logic: addEdit(item, item.name.replace(...)) -> replaces the FQN part?

    // Actually the logic was: `addEdit(item, item.name.replace(oldNamespace, newNamespace));`
    // oldNamespace = App\Services
    // newNamespace = App\Utils
    // item.name = App\Services\OldService
    // expected = App\Utils\OldService

    if (refEdit.newText === 'App\\Utils\\OldService') {
        console.log("PASS: Reference updated correctly.");
    } else {
        console.error("FAIL: Reference update incorrect.", refEdit.newText);
        process.exit(1);
    }

    console.log("ALL TESTS PASSED");
}

runTest().catch(e => console.error(e));
