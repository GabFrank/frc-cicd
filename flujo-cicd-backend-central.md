# Flujo CI/CD — Backend Central

## Flujo de desarrollo

```
feature branch → PR a develop → CI (build+test) → merge → release alpha → deploy manual
```

### 1. Crear feature branch y PR
```bash
git checkout develop
git pull
git checkout -b feat/mi-feature
# ... hacer cambios, commits con conventional commits ...
git push -u origin feat/mi-feature
gh pr create --base develop
```

### 2. CI automatico
Al crear el PR, GitHub Actions ejecuta `ci.yml`:
- Build con Maven
- Tests con PostgreSQL
- Si falla: corregir en la misma branch y pushear

### 3. Merge a develop
Una vez CI verde, mergear el PR. Esto dispara `release.yml`:
- semantic-release analiza los commits
- Crea tag + GitHub Release con JAR adjunto
- Versiones: `develop` → alpha, `release/*` → beta, `master` → estable

### 4. Deploy manual
Ir a **Actions → Deploy → Run workflow**:
- Elegir version (ej: `3.1.0-alpha.7`)
- Elegir instancia: `alpha` (pruebas), `farmacia` (beta), `bodega` (produccion)
- `bodega` requiere aprobacion antes de ejecutar

### 5. Que hace el deploy
1. Descarga el JAR de GitHub Release
2. Lo sube al servidor via SCP
3. Actualiza symlink `current → releases/{version}`
4. Reinicia el servicio systemd
5. Health check durante 120s
6. Si falla → rollback automatico a version anterior

## Conventional commits (obligatorio)

| Prefijo | Descripcion | Bump |
|---|---|---|
| `feat:` | Nueva funcionalidad | minor (3.1.0 → 3.2.0) |
| `fix:` | Correccion de bug | patch (3.1.0 → 3.1.1) |
| `BREAKING CHANGE:` | Cambio incompatible | major (3.1.0 → 4.0.0) |
| `ci:` / `docs:` / `chore:` | Sin release | - |

## Rollback manual (emergencia)
```bash
ssh deploy@$CENTRAL_PUBLIC_IP
ln -sfn /opt/frc-backend-central/releases/{VERSION_ANTERIOR} /opt/frc-backend-central/{instancia}/current
sudo systemctl restart frc-{instancia}.service
```

## Reglas

- **No push directo** a `master` ni `develop` — siempre via PR
- **No force push** a `master` ni `develop`
- **Deploy a produccion** requiere aprobacion
- **Viernes:** solo preparar infraestructura, no deploys ni merges criticos
