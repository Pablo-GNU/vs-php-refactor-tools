# PHP Refactor Tools
![Extension Icon](images/icon.png)

**PHP Refactor Tools** is an all-in-one extension designed to supercharge your PHP development workflow in Visual Studio Code. It combines code generation, intelligent import management, advanced refactoring capabilities, and powerful integrations with industry-standard tools like PHPStan, PHP_CodeSniffer, and PHP-CS-Fixer.

---

## ✨ Key Features

### 1. PHP File Generator
Create new PHP structures quickly without writing boilerplate code manually.
- **Support for**: Classes, Interfaces, Traits, Abstract Classes, and Final Classes
- **Interactive Wizard**: Guides you step-by-step to define name, type, and options like `strict_types`
- **Inheritance Autocomplete**: Select classes for `extends` and interfaces for `implements` from your project
- **Namespaces**: Automatically detects namespace based on folder structure (PSR-4 support)

**Usage:**
- Right-click on a folder in the file explorer and select **"New PHP Class..."**
- Or use the command: `PHP Refactor Tools: New PHP Class...`

---

### 2. Intelligent Import Management

Never write `use App\Services\MyService;` manually again.

- **Automatic Indexing**: Extension indexes your project in the background to discover all your classes
- **Auto-Import**: Use a class without importing it, press `Ctrl+.` (or the lightbulb) and select **"Add import for..."**
- **Alias Detection**: Supports correct import even if the class has the same name as another
- **Clean and Ordered**: Imports are inserted in alphabetical order in the correct block
- **Missing Import Detection**: Automatically detects when you use a class without importing it and offers quick fixes

**Features:**
- ✅ Detects missing imports in type hints, `new` statements, static calls, extends/implements
- ✅ Handles namespaced classes correctly
- ✅ Respects existing `use` statements
- ✅ Formats imports alphabetically with proper spacing

---

### 3. Advanced Code Navigation

Navigate through your PHP codebase like a pro:

- **Go to Definition** (`F12`): Jump to class/interface/trait definitions
- **Go to Implementation** (`Ctrl+F12`): Find all implementations of an interface
- **Find All References** (`Shift+F12`): Locate all usages of a class/interface/trait

> **Note**: Enable navigation features in settings: `phpRefactorTools.navigation.enabled`

---

### 4. Class-Aware Method Renaming 🆕

Rename methods intelligently with full class context awareness:

- **Class-Specific**: Only renames methods in the specific class you're editing
- **Type Inference**: Understands `$this->method()`, `$obj->method()`, and `Class::method()`
- **Smart Detection**: Tracks variable assignments like `$obj = new MyClass()`
- **No False Positives**: Won't rename `UserController::handle()` when you meant `OrderController::handle()`

**How it works:**
1. Place cursor on a method name (definition or usage)
2. Press `F2` (Rename Symbol)
3. Enter new name
4. Only that specific class's method gets renamed ✅

**Example:**
```php
class UserController {
    public function handle() { }  // Rename this
}

class OrderController {
    public function handle() { }  // This stays unchanged ✅
}
```

---

### 5. Smart Refactoring (Move & Rename)
The extension automatically detects when you move or rename PHP files in the VS Code explorer.

**Features:**
- **Automatic Detection**: Just drag & drop files in the explorer.
- **Preview Changes**: A preview window appears showing all affected files (namespace updates, import fixes).
- **Safety First**: Review changes line-by-line before applying. Cancel to abort the move.
- **Integration**: Works natively with VS Code's refactoring UI.

**Commands:**
- `PHP Refactor Tools: Move File with Namespace Update` (Manual alternative)

**What updates automatically:**
- ✅ Namespace declaration in moved file
- ✅ Existing `use` statements in other files
- ✅ New `use` statements added where needed (for files that were in the same namespace)

---

### 6. Static Analysis with PHPStan

Integrate [PHPStan](https://phpstan.org/) directly in the editor to find errors before running code.

- **Real-time Analysis**: Runs PHPStan when you save the file (configurable)
- **Manual Execution**: Commands to analyze current file or entire workspace
- **Flexible Configuration**: Define analysis level and configuration file (`phpstan.neon`)

**Commands:**
- `PHP Refactor Tools: Run PHPStan on Current File`
- `PHP Refactor Tools: Run PHPStan on Workspace`

---

### 7. Code Style and Formatting

Maintain clean and consistent code with standards (PSR-12, etc.).

#### PHP_CodeSniffer (PHPCS)
Shows style warnings and errors directly in the editor.
- **Command**: `PHP Refactor Tools: Run PHPCS on Current File`
- **Integration**: Runs automatically on save (if enabled)

#### PHP-CS-Fixer
Automatically fixes style issues.
- **Fix on Save**: Can be configured to auto-fix files on save
- **Command**: `PHP Refactor Tools: Fix Code Style (PHP-CS-Fixer)`

---

## ⚙️ Configuration

Customize the extension behavior by editing your `settings.json` or using VS Code's settings UI (`Ctrl+,` and search "PHP Refactor Tools").

### Indexer Settings

| Setting | Description | Type | Default |
|---------|-------------|------|---------|
| `phpRefactorTools.indexer.enabled` | Enable/disable automatic PHP file indexing for import autocomplete | `boolean` | `true` |
| `phpRefactorTools.indexer.excludeVendor` | Exclude `vendor/` folder from index to improve performance | `boolean` | `true` |
| `phpRefactorTools.indexer.exclude` | List of directories to completely ignore during indexing | `array` | `["vendor", "node_modules", "storage", "var"]` |

### Navigation Settings

| Setting | Description | Type | Default |
|---------|-------------|------|---------|
| `phpRefactorTools.navigation.enabled` | Enable Go to Definition, Implementation, and References | `boolean` | `false` |

### PHPStan Settings

| Setting | Description | Type | Default |
|---------|-------------|------|---------|
| `phpRefactorTools.phpstan.enabled` | Enable PHPStan integration | `boolean` | `false` |
| `phpRefactorTools.phpstan.configFile` | Path to PHPStan configuration file | `string` | `phpstan.neon` |
| `phpRefactorTools.phpstan.level` | PHPStan strictness level (0-9 or "max") | `string` | `"max"` |

### PHPCS Settings

| Setting | Description | Type | Default |
|---------|-------------|------|---------|
| `phpRefactorTools.phpcs.enabled` | Enable PHP_CodeSniffer linter | `boolean` | `false` |
| `phpRefactorTools.phpcs.standard` | Coding standard to use (PSR12, PSR2, Symfony) | `string` | `"PSR12"` |
| `phpRefactorTools.phpcs.configFile` | Path to custom phpcs.xml configuration file | `string` | `""` |

### PHP-CS-Fixer Settings

| Setting | Description | Type | Default |
|---------|-------------|------|---------|
| `phpRefactorTools.phpCsFixer.enabled` | Enable PHP-CS-Fixer integration | `boolean` | `false` |
| `phpRefactorTools.phpCsFixer.configFile` | Path to configuration file (`.php-cs-fixer.php`) | `string` | `.php-cs-fixer.php` |
| `phpRefactorTools.phpCsFixer.onSave` | Auto-fix code style on file save | `boolean` | `false` |

---

## 📋 Example Configuration

Here's a recommended `.vscode/settings.json` for a typical project:

```json
{
  "phpRefactorTools.indexer.enabled": true,
  "phpRefactorTools.indexer.excludeVendor": true,
  "phpRefactorTools.navigation.enabled": true,
  
  "phpRefactorTools.phpstan.enabled": true,
  "phpRefactorTools.phpstan.level": "8",
  "phpRefactorTools.phpstan.configFile": "phpstan.neon",
  
  "phpRefactorTools.phpcs.enabled": true,
  "phpRefactorTools.phpcs.standard": "PSR12",
  
  "phpRefactorTools.phpCsFixer.enabled": true,
  "phpRefactorTools.phpCsFixer.onSave": true
}
```

---

## 📦 Requirements

For the best experience, install these tools in your project via Composer:

```bash
composer require --dev phpstan/phpstan
composer require --dev squizlabs/php_codesniffer  
composer require --dev friendsofphp/php-cs-fixer
```

If the tools aren't installed in the project, the extension will try to use global versions from your PATH, but local per-project installation is recommended.

---

## 🚀 Usage Examples

### Creating a New Class

1. Right-click on a folder → **"New PHP Class..."**
2. Enter class name: `UserService`
3. Select type: **Class**
4. Choose options (final, abstract, strict types)
5. Select parent class or interfaces (if any)
6. File created with correct namespace! ✅

### Adding Missing Imports

```php
<?php
namespace App\Controllers;

class UserController {
    public function index() {
        // UserService is used but not imported
        $service = new UserService();  // ⚠️ Red underline
        //              ↑ Press Ctrl+. here
        //              → "Add import for UserService"
        //              → Done! ✅
    }
}
```

### Renaming a Method (Class-Aware)

```php
// Before
class ShoppingCart {
    public function calculate() { return 100; }
    public function getTotal() { return $this->calculate(); }
}

// Place cursor on "calculate", press F2, rename to "computeTotal"

// After - only ShoppingCart methods renamed! ✅
class ShoppingCart {
    public function computeTotal() { return 100; }
    public function getTotal() { return $this->computeTotal(); }
}
```

### Moving a File

1. Drag `Services/UserService.php` to `Domain/User/UserService.php`
2. Extension automatically:
   - Updates namespace in `UserService.php` ✅
   - Updates all `use` statements in other files ✅
   - Adds new `use` statements where needed ✅

---

## 🔧 Troubleshooting

### Import suggestions not appearing?

1. Ensure the file with the class is in an indexed folder
2. Run: `PHP Refactor Tools: Check Integration Status`
3. Try: `PHP Refactor Tools: Rebuild Index`

### PHPStan/CS-Fixer not working?

1. Verify executables exist (`vendor/bin/phpstan`, etc.)
2. Check Output panel → Select "PHP Refactor Tools" dropdown
3. Look for detailed error logs

### Method rename affecting wrong class?

- This shouldn't happen anymore with class-aware detection
- If it does, check the Output panel for logs
- File an issue with reproduction steps

### Navigation (Go to Definition) not working?

1. Enable navigation: `"phpRefactorTools.navigation.enabled": true`
2. Rebuild index: `PHP Refactor Tools: Rebuild Index`
3. Ensure file is indexed (not in excluded directories)

---

## 🎯 Advanced Features

### Refactoring Tools

- **Rebuild Index**: Force re-indexation if imports don't work
  - Command: `PHP Refactor Tools: Rebuild Index`
- **Inspect Index**: Debug tool to see what the extension knows about your classes
  - Command: `PHP Refactor Tools: Inspect Index (Debug)`

### PSR-4 Namespace Detection

The extension automatically detects your namespace from:
- `composer.json` PSR-4 autoload configuration
- Folder structure relative to PSR-4 roots

Example:
```
src/
  Domain/
    User/
      UserService.php  → namespace App\Domain\User;
```

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Add Import | `Ctrl+.` (Quick Fix) |
| Go to Definition | `F12` |
| Go to Implementation | `Ctrl+F12` |
| Find All References | `Shift+F12` |
| Rename Symbol | `F2` |

---

## 📝 License

This extension is provided as-is for development purposes.

## 🤝 Contributing

Issues and feature requests are welcome!

---

## 🎉 What's New

### v1.0.0
- ✨ **Class-Aware Method Renaming**: Only rename methods in the specific class
- ✨ **Smart Type Inference**: Understands `$this`, variable assignments, and static calls
- ✨ **File Move Refactoring**: Automatic namespace and import updates when moving files
- ✨ **Missing Import Detection**: Automatic detection for files previously in same namespace
- 🐛 **Fixed**: Import detection for all PHP node types (extends, implements, type hints)
- 🐛 **Fixed**: Import formatting with proper alphabetical sorting and spacing

---

Made with ❤️ for PHP developers
