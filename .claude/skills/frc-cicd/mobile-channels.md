# Mobile — modelo de canales con Play Store

**Fecha de implementación:** 2026-04-22. Validado end-to-end en alpha + beta el mismo día.

**Decisión de arquitectura:** se descartó Capgo / CapacitorUpdater (OTA) porque el CI ya sube AABs por canal automáticamente y el tiempo de propagación Play Store (~15 min) no es un problema operacional para el tamaño del proyecto. Menos deuda, menos vendor lock-in. Ver CLAUDE.md del repo mobile para el razonamiento detallado.

## Mapping canal git → Play Console track

| Canal git | Branch | Tag | Play Track | Opt-in URL |
|---|---|---|---|---|
| Alpha | `develop` | `vX.Y.Z-alpha.N` | **Internal testing** | `https://play.google.com/apps/internaltest/4701535382290616522` |
| Beta | `release/beta` | `vX.Y.Z-beta.N` | **Open testing** (único permitido por app) | `https://play.google.com/apps/testing/com.sistemasinformaticos.frc` |
| Stable | `master` | `vX.Y.Z` | **Production** | `https://play.google.com/store/apps/details?id=com.sistemasinformaticos.frc` |

Estas URLs están hardcoded en `src/app/services/channel.service.ts` del repo mobile. Si el `NUMERIC_ID` del internal testing track cambia en Play Console (eventualmente al recrear la app), actualizarlo ahí.

## Selector in-app

`src/app/services/channel.service.ts` + menú lateral "Configuración → Canal de actualizaciones".

- Detección del canal actual vía regex sobre `versionName` (`-alpha.N` → alpha, `-beta.N` → beta, plain → stable).
- Cada botón del action sheet (`ActionSheetController`) llama `Browser.open({url})` del plugin `@capacitor/browser`.
- Custom Tab se abre dentro de la app. Play Store decide qué programa ofrecer según la invitación del email del usuario.

**No hay instalación forzada desde la app** — Play Store es intermediario obligatorio. Al unirse al programa, Play Store baja el AAB del track en ~5-15 min (automático si auto-update está activo).

## Limitaciones Play Console clave

1. **Solo un track de Open testing por app.** No se puede tener alpha y beta como open simultáneos. Por eso alpha queda en Internal testing (email list max 100) y beta en Open testing (sin lista).
2. **Internal testing requiere email list** — hasta 100 correos Gmail, invitación 1:1. Filial pilot usa lista `alpha` con un par de devs.
3. **Open testing primer AAB pasa review** (~horas a 1 día). Las subidas posteriores al track son instantáneas.
4. **Closed testing** permite múltiples tracks (Alpha, Beta, etc. cerrados) pero todos requieren email list. Si se usa closed, el URL de opt-in es el mismo (`apps/testing/...`) y Play Store filtra por invitación del email.
5. **Cambio de canal desde el device = ir a Play Store.** No hay forma programática de hacer el opt-in dentro de la app.

## Flujo típico de release mobile

```bash
# 1. Feature en develop
git checkout develop && git pull
git checkout -b feature/foo
# commits...
# PR a develop → CI corre → merge commit

# 2. release.yml arranca automático → tag v1.1.0-alpha.N + AAB + GitHub Release

# 3. Deploy manual a track=internal
gh workflow run "Deploy to Play Store" --ref develop -f version=1.1.0-alpha.N -f track=internal

# 4. Promover a beta: PR develop → release/beta (merge commit, NO squash)
gh pr create --base release/beta --head develop --title "chore(release): promote"
gh pr merge <NUM> --merge

# 5. release.yml en release/beta → tag -beta.N + AAB

# 6. Deploy a track=beta
gh workflow run "Deploy to Play Store" --ref release/beta -f version=1.1.0-beta.N -f track=beta

# 7. Promover a stable: PR release/beta → master (merge commit)
# idem con track=production
```

## Gotcha específico — `ng test` y `ng lint` rotos

El repo mobile tiene roto:
- `ng lint` → `@angular-eslint/builder:lint not found`. **Confirmado el 2026-09-02**: `angular.json`
  declara ese builder y `@angular-eslint` no está ni en `devDependencies` ni instalado.
- `ng test` → **el typo del import ya no existe** (revisado 2026-09-02: el archivo
  `edit-transferenci-producto.component.spec.ts` y la clase `EditTransferenciaProductoComponent`
  coinciden, el import resuelve). Si `ng test` falla hoy, es por otra causa: diagnosticar, no
  asumir este TS2724.

Son pre-existentes, no bloquean el build AOT de producción (`npm run build` sí pasa).

**Al validar un PR del repo mobile:** corré `npm run build` y `npx cap sync android`. NO dependas de `ng test` ni `ng lint` como gate hasta que se arregle la infra en un PR dedicado.

## Workflow `Deploy to Play Store` contract

Input `track`:
- `internal` → alpha
- `alpha` → alpha closed testing (track diferente al internal, rarely used)
- `beta` → open testing
- `production` → stable

Input `version`: dejar vacío → workflow resuelve el último tag del canal según `[.[] | select(.prerelease == true and (.tag_name | contains("<channel>")))][0]`.

Warning pre-existente en el workflow: `'track' is deprecated, migrate to 'tracks'`. No bloquea. A arreglar cuando `r0adkll/upload-google-play` suba a una versión que lo imponga.
