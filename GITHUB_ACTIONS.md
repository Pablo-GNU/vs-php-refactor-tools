# GitHub Actions CI/CD

Este proyecto usa GitHub Actions para automatizar el proceso de build y release.

## Workflows Configurados

### 1. Build and Test (`build.yml`)
**Trigger**: Push a `master` o Pull Request

**Acciones**:
- Compila TypeScript
- Ejecuta tests de verificación
- Genera el paquete VSIX
- Sube como artifact (disponible 30 días)

**Matrices**: Prueba con Node.js 16.x y 18.x

### 2. Release (`release.yml`)
**Trigger**: Push de tags con formato `v*.*.*` (ej: `v1.0.1`)

**Acciones**:
- Compila y empaqueta la extensión
- Crea un GitHub Release automáticamente
- Adjunta el archivo `.vsix` al release
- Genera release notes automáticas

## Uso

### Para desarrollo normal:
```bash
git push origin master
```
Esto ejecutará el build y tests automáticamente.

### Para hacer un release:
```bash
# Usa los scripts npm que ya están configurados
npm run release:hotfix   # Crea tag v1.0.1
npm run release:minor    # Crea tag v1.1.0
npm run release:major    # Crea tag v2.0.0
```

Estos comandos automáticamente:
1. Actualizan `package.json`
2. Hacen commit
3. Crean el tag
4. Hacen push (que **dispara el workflow de release**)
5. GitHub Actions crea el release con el `.vsix`

## Ver resultados

- **Actions tab** en GitHub: Ver logs de builds
- **Releases** en GitHub: Descargar VSIX compilados
- **Artifacts** en cada build: Descargar VSIX de cualquier commit

## Permisos necesarios

El workflow de release usa `GITHUB_TOKEN` que está disponible automáticamente.
No necesitas configurar secrets adicionales.
