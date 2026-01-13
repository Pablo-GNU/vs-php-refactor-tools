# Version Bumping Guide

## Quick Commands

### From Terminal
```bash
# Hotfix (patch): 1.0.0 -> 1.0.1
npm run release:hotfix

# Feature Release (minor): 1.0.0 -> 1.1.0
npm run release:minor

# Breaking Change (major): 1.0.0 -> 2.0.0
npm run release:major
```

### From VS Code
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Tasks: Run Task"
3. Select one of:
   - **Release: Hotfix (patch)** - For bug fixes
   - **Release: Minor (feature)** - For new features
   - **Release: Major (breaking)** - For breaking changes

## What Happens

Each `release:*` command:
1. Bumps the version in `package.json`
2. Creates a git commit with the message: `Hotfix: vX.X.X` (or `Release:` / `Breaking:`)
3. Creates a git tag: `vX.X.X`
4. Pushes the commit and tags to remote

## Manual Version Bumping (without push)

If you only want to bump the version locally without pushing:

```bash
npm run version:patch   # 1.0.0 -> 1.0.1
npm run version:minor   # 1.0.0 -> 1.1.0  
npm run version:major   # 1.0.0 -> 2.0.0
```

## Semantic Versioning

- **Patch (1.0.X)**: Bug fixes, hotfixes, small tweaks
- **Minor (1.X.0)**: New features, non-breaking changes
- **Major (X.0.0)**: Breaking changes, API changes
