# Guia de Desarrollo con CI/CD — FRC Sistemas Informaticos

> **Alcance: los 5 repos del producto.** El flujo de ramas, commits, PRs y
> releases de esta guia vale igual para `central`, `filial`, `desktop`, `mobile`
> y `mobile-pwa`. Lo unico que cambia por componente es **como se deploya** el
> artefacto — ver la seccion 4 y, para la PWA, [plan-cicd-mobile-pwa.md](plan-cicd-mobile-pwa.md).

**Para:** Todo el equipo de desarrollo
**Fecha:** 2026-03-26
**Version:** Final (consolidado de 3 propuestas: claude, gemini, codex)

---

## El flujo en 30 segundos

```
1. Crear branch desde develop       →  feature/ventas-filtro-estado
2. Hacer commits con formato         →  feat(ventas): agregar filtro por estado
3. Push y crear PR hacia develop     →  CI corre automaticamente
4. Reviewer aprueba                  →  Merge a develop
5. Se genera release alpha           →  Automatico, no hacer nada
6. Deploy a produccion               →  Manual, con aprobacion
```

Ya no necesitas compilar `.jar`, `.exe`, ni `.apk` localmente. Tu responsabilidad es escribir codigo de calidad, commitearlo con el formato correcto, y crear PRs. El resto es automatico.

---

## 1. Ramas

### Estructura

```
master              ← produccion (protegida, solo merge via PR)
  └─ release/beta   ← beta / candidato a release (protegida, solo merge via PR)
       └─ develop   ← integracion (protegida, solo merge via PR)
            ├─ feature/modulo-descripcion   ← funcionalidades nuevas
            ├─ fix/modulo-descripcion       ← correcciones de bugs
            ├─ refactor/modulo-descripcion  ← mejoras internas
            ├─ chore/descripcion            ← tareas tecnicas
            └─ hotfix/descripcion           ← urgencias de produccion (sale de master)
```

> **Importante:** Estos repos usan `master` (no `main`) y una branch `release/beta` long-lived (no `release/x.y.z` por version). Los workflows de CI/CD escuchan ambos nombres en algunos casos pero la convencion oficial es la de arriba.

### Canales

| Rama | Canal | Quien la usa |
|---|---|---|
| `develop` | alpha | Equipo interno, laboratorio |
| `release/beta` | beta | Filial piloto, testers |
| `master` | production | Todas las empresas |

### Reglas

- **Siempre crear la branch desde `develop`** (excepto hotfix → sale de `master`).
- **Nunca trabajar directamente en `develop` ni en `master`.** Ambas estan protegidas con `enforce_admins=true`.
- **Una branch por tarea.** No mezclar cambios no relacionados.

### Nombres

Formato: `tipo/modulo-descripcion-corta`

| Tipo | Ejemplo |
|---|---|
| Funcionalidad | `feature/ventas-filtro-estado` |
| Bug fix | `fix/caja-error-redondeo` |
| Refactor | `refactor/compra-validaciones-form` |
| Tarea tecnica | `chore/actualizar-dependencias` |
| Hotfix produccion | `hotfix/facturacion-timeout-sifen` |

Usar minusculas, separar palabras con guiones. Sin espacios, acentos ni mayusculas.

### Comandos

```bash
# Crear branch de feature
git checkout develop
git pull origin develop
git checkout -b feature/ventas-filtro-estado

# Crear branch de hotfix (desde master)
git checkout master
git pull origin master
git checkout -b hotfix/facturacion-timeout-sifen
```

---

## 2. Commits

El sistema de versionado automatico (semantic-release) lee los mensajes de commit para decidir la version. Si el commit no sigue el formato, no genera version.

### Formato

```
tipo(scope): descripcion en minusculas
```

El `scope` (modulo) es opcional pero recomendado. Ayuda a identificar rapidamente que area del sistema se toco.

### Tipos

| Tipo | Cuando usarlo | Efecto en la version |
|---|---|---|
| `feat` | Funcionalidad nueva para el usuario | Sube MINOR (3.0.9 → 3.1.0) |
| `fix` | Correccion de un bug | Sube PATCH (3.0.9 → 3.0.10) |
| `refactor` | Cambio interno sin efecto visible | No genera version |
| `chore` | Tarea tecnica (deps, configs) | No genera version |
| `docs` | Solo documentacion | No genera version |
| `test` | Solo tests | No genera version |
| `perf` | Mejora de rendimiento | No genera version |
| `ci` | Cambios en workflows CI/CD | No genera version |

> **Solo `feat` y `fix` generan nueva version.** Los demas tipos son validos pero no disparan release.

### Ejemplos correctos

```bash
git commit -m "feat(ventas): agregar filtro por estado de pedido"
git commit -m "fix(stock): corregir calculo de costo promedio"
git commit -m "refactor(compra): simplificar validacion de formulario"
git commit -m "chore: actualizar spring-boot a 2.1.16"
git commit -m "feat: agregar endpoint de busqueda de clientes"
```

### Ejemplos INCORRECTOS (seran rechazados)

```bash
git commit -m "arreglar bug del login"           # sin tipo
git commit -m "Fix: corregir login"               # tipo con mayuscula
git commit -m "feat: Agregar filtro"              # descripcion con mayuscula
git commit -m "update: cambiar color del boton"   # tipo inventado
git commit -m "feat:sin espacio"                  # falta espacio despues de :
```

### Commits con cuerpo (para cambios grandes)

```bash
git commit -m "feat(productos): agregar cache en memoria

Reduce las consultas a la DB de 50/seg a 5/seg.
El cache se invalida cada 5 minutos."
```

La primera linea es el titulo (lo que semantic-release lee). Las siguientes son el cuerpo (opcional, para contexto).

### Breaking changes

Si tu cambio rompe la API o requiere que otros ajusten su codigo:

```bash
git commit -m "feat!: cambiar formato de respuesta del endpoint /productos

BREAKING CHANGE: el campo 'precio' ahora es un objeto {valor, moneda} en vez de un numero."
```

El `!` despues del tipo o el texto `BREAKING CHANGE:` en el cuerpo sube la version MAJOR (3.0.9 → 4.0.0). **Usar con extremo cuidado** — esto implica que filiales, desktop y mobile necesitan actualizarse.

### Si commitlint me rechaza

En proyectos frontend (Desktop y Mobile), `commitlint` bloquea el commit localmente. Corregi el mensaje y volve a intentar.

En proyectos backend (Java), no hay validacion local — se valida en CI al crear el PR. Si falla:

```bash
# Si el commit NO fue pusheado todavia
git commit --amend -m "fix(caja): corregir calculo de descuento"

# Si ya fue pusheado, hacer un nuevo commit correcto
git commit -m "fix(caja): corregir calculo de descuento"
git push
```

---

## 3. Pull Requests

### Hacer push

```bash
# Primer push (crea la branch remota)
git push -u origin feature/ventas-filtro-estado

# Pushes siguientes
git push
```

### Crear el PR en GitHub

1. GitHub muestra banner: "feature/ventas-filtro-estado had recent pushes — Compare & pull request"
2. Click en **"Compare & pull request"**
3. Configurar:
   - **Base:** `develop` (hacia donde va el merge)
   - **Compare:** tu branch
   - **Titulo:** formato de commit: `feat(ventas): agregar filtro por estado`
4. En la **descripcion**, incluir:
   - Que problema resuelve
   - Como probarlo
   - Impacto en base de datos (si aplica)
   - Impacto en rollback (si aplica)
   - Riesgo (bajo/medio/alto)
5. Click en **"Create pull request"**
6. Asignar al menos 1 reviewer en la barra lateral

### Que pasa automaticamente

El **CI** se ejecuta y hace:
- **Backend:** compila con Maven, corre tests, corre SpotBugs
- **Frontend:** instala dependencias, lint, tests, build

Indicadores:
- Amarillo "Checks in progress" → esperando
- Verde → todo paso, se puede mergear
- Rojo → fallo. Click en "Details" para ver el log y corregir

### Mergear

Cuando CI esta verde y el reviewer aprobo:

1. Click en **"Merge pull request"** (usar merge commit, NO squash)
2. Click en **"Confirm merge"**
3. Opcionalmente borrar la branch

> **Merge commit, no squash.** semantic-release necesita leer cada commit individual para decidir la version.

### Buenas practicas de PR

- PRs pequenos: **idealmente menos de 400 lineas** de cambio neto
- Una responsabilidad por PR — no mezclar feature + refactor + migracion de DB
- Sin commits "WIP" al mergear — limpiar el historial antes
- Revisar impacto cross-proyecto: si cambias un endpoint del backend, verificar que desktop/mobile no se rompen

---

## 4. Releases y Deploy

### Que pasa despues del merge

Al mergear a `develop`, semantic-release analiza los commits automaticamente:

| Commits incluyen... | Version generada | Ejemplo |
|---|---|---|
| Al menos un `feat` | MINOR alpha | `v3.1.0-alpha.1` |
| Solo `fix` | PATCH alpha | `v3.0.10-alpha.1` |
| Solo `chore`, `refactor`, etc. | **Nada** — no se genera release | — |

El release aparece en **GitHub → Releases** con:
- Tag de la version
- Notas de cambios (generadas automaticamente de tus commits)
- Artefacto adjunto (JAR, AppImage, EXE, APK segun el proyecto)

**No hay nada que hacer manualmente.** Ya no compilas JAR ni instaladores localmente.

### Release ≠ Deploy

Que exista un release NO significa que se despliega a produccion. Son dos cosas separadas.

### Deploy por componente

| Componente | Como se despliega | Quien lo hace |
|---|---|---|
| Backend Central | GitHub Actions → workflow "Deploy" → elegir version y environment | Lider Tecnico (manual, con aprobacion) |
| Backend Filial | Automatico via script cada 15 min (cron/Task Scheduler) | Nadie — se actualiza solo segun el canal configurado |
| Desktop | Automatico via electron-updater (detecta al abrir la app, check cada 5 min) | Nadie — el usuario acepta la actualizacion en el dialogo |
| Mobile | GitHub Actions → workflow "Deploy Play Store" → elegir track | Lider Tecnico (manual) |

### Flujo de release por canal

```
develop  ──merge──►  release alpha (automatico)
                     ↓ validar en laboratorio

release/beta  ──merge──►  release beta (automatico)
                          ↓ validar en piloto

master  ──merge──►  release produccion (automatico)
                    ↓ deploy manual con aprobacion
```

### Changelog

El historial de cambios de cada version vive en **GitHub → Releases**. No hay un archivo `CHANGELOG.md` local. Si necesitas saber que cambio en `v3.1.5`, entra a la pestana Releases del repo.

---

## 5. Cambios en la base de datos (Flyway)

**Esta es la seccion mas critica del documento.** Una migracion mal hecha puede dejar el sistema inoperativo y el rollback automatico NO la revierte.

### Como funciona

Flyway ejecuta migraciones de DB al arrancar la aplicacion. Los archivos estan en:

```
src/main/resources/db/migration/
  V0__initial_schema.sql
  V1__agregar_campo_email_cliente.sql
  V2__crear_tabla_auditoria.sql
```

Una vez ejecutada, **una migracion no se puede modificar ni eliminar** — Flyway compara checksums y falla si detecta cambios.

### Regla de oro: migraciones siempre ADITIVAS

| PERMITIDO | PROHIBIDO |
|---|---|
| `CREATE TABLE` | `DROP TABLE` |
| `ALTER TABLE ADD COLUMN` | `ALTER TABLE DROP COLUMN` |
| `CREATE INDEX` | `ALTER TABLE RENAME COLUMN` |
| `ALTER TABLE ALTER COLUMN SET DEFAULT` | `ALTER TABLE ALTER COLUMN TYPE` (cambiando tipo) |
| `INSERT INTO` (datos de referencia) | `DELETE FROM` / `TRUNCATE` |

### Por que? El problema del rollback

Cuando se hace rollback (se vuelve al JAR anterior), la base de datos **NO se revierte**. Si la migracion elimino una columna que el JAR anterior necesita, el sistema queda roto.

```
Ejemplo de desastre:

1. Version 3.1.0: migracion V5 hace DROP COLUMN telefono
2. Se despliega 3.1.0 → funciona (ya no usa telefono)
3. Se detecta un bug critico → rollback a 3.0.10
4. Version 3.0.10 intenta leer columna telefono → CRASH
5. El sistema esta caido y el rollback automatico no sirve
6. Hay que restaurar backup de DB manualmente → minutos u horas de caida
```

### Como eliminar o renombrar columnas de forma segura

Estrategia de **2 versiones:**

**Version N (preparacion):**
```sql
-- V5__deprecar_campo_telefono.sql
ALTER TABLE clientes ADD COLUMN telefono_nuevo VARCHAR(20);
```
El codigo de la version N deja de leer `telefono` y empieza a usar `telefono_nuevo`. Ambas columnas coexisten.

**Version N+1 (limpieza, solo cuando N esta estable en produccion):**
```sql
-- V8__eliminar_campo_telefono_viejo.sql
ALTER TABLE clientes DROP COLUMN telefono;
ALTER TABLE clientes RENAME COLUMN telefono_nuevo TO telefono;
```
Esto es seguro porque si se necesita rollback a N, la columna vieja todavia existe.

### Naming de migraciones

```
V{numero}.5__{descripcion_con_underscores}.sql
```

- **Usar sufijo `.5`** en las migraciones nuevas (ej. `V176.5__agregar_indice.sql`) — **no `.0` ni el entero pelado**.
  - **Motivo:** Flyway **normaliza el `.0`** → trata `V176` == `V176.0`. Así, un `V176.0` de una rama **colisiona** con un `V176` de otra al mergear (nos pasó al integrar develop: su `V151__add_trigram` chocó con un `V151.0__...` de una feature). El sufijo **`.5` no se normaliza a entero**, así que nunca choca con la variante entera, y ademas slotea la migracion **entre** los enteros de develop (`out-of-order=true` lo soporta).
  - **Cuidado:** el `.5` evita el choque entero-vs-`.0`, pero **no** evita que dos ramas elijan el mismo `V176.5`. Igual conviene tomar el **proximo entero libre** de la rama + `.5`, y coordinar si hay features paralelas grandes.
- Numero **unico**; **nunca reusar** ni **modificar** una migracion ya aplicada.
- Descripcion clara: `V176.5__agregar_indice_producto_codigo.sql`

### Probar localmente antes de pushear

```bash
SPRING_PROFILES_ACTIVE=ci ./mvnw clean verify
```

Si la migracion tiene errores, Flyway falla en el verify y no llega a CI.

### Checklist para PR con cambio de DB

- [ ] La migracion tiene archivo versionado (`V{n}__...sql`)
- [ ] Fue probada en entorno local
- [ ] Es compatible con la version anterior del backend (retrocompatible)
- [ ] No hace DROP/RENAME sin la estrategia de 2 versiones
- [ ] El PR documenta el impacto en la DB y el plan de rollback

---

## 6. Cambios con riesgo de rollback (mas alla de DB)

### Variables de entorno

Si tu codigo necesita una variable de entorno nueva (ej: `API_KEY_NUEVA`), **avisarle al Lider Tecnico ANTES de crear el PR**. El debe crearla en los servidores antes de que tu codigo se despliegue. Si no existe, la aplicacion falla al arrancar.

### Archivos o directorios locales

Si tu codigo espera que exista una carpeta en disco (ej: `/opt/frc/fotos-temp/`), tu codigo Java debe crearla programaticamente (`Files.createDirectories()` o `File.mkdirs()`) si no existe. No asumas que el servidor la tiene.

### Cambios en la API (GraphQL/REST)

Si modificas la respuesta de un endpoint que el desktop o mobile consumen:

1. **No eliminar campos existentes de golpe.** Agregar el campo nuevo, mantener el viejo.
2. Recien cuando todos los clientes esten actualizados, eliminar el campo viejo en una version posterior.
3. Si es inevitable, marcarlo como breaking change: `feat!: cambiar respuesta de /productos`

### Nombres de artefactos

Los scripts de auto-update de filiales esperan que el JAR se llame `frc-filial-server.jar`. **No cambiar este nombre** sin coordinar con el equipo y actualizar los scripts primero.

### Regla general

Si un cambio puede impedir el rollback, **dividirlo en etapas** y desplegar gradualmente. Nunca mezclar refactor grande + cambio critico + migracion destructiva en un mismo PR.

---

## 7. Hotfix: urgencias en produccion

### Opcion A: Revert rapido (preferida)

Si el bug fue introducido por un commit reciente y se puede deshacer:

```bash
git checkout develop
git pull origin develop
git revert <hash-del-commit>
git push origin develop
```

Esto genera un nuevo release automatico. Para backend central, ejecutar deploy manual.

### Opcion B: Hotfix branch (para fixes que necesitan desarrollo)

```bash
# Crear branch desde master (produccion)
git checkout master
git pull origin master
git checkout -b hotfix/facturacion-timeout-sifen

# Desarrollar el fix
git commit -m "fix(facturacion): aumentar timeout de conexion a sifen"
git push -u origin hotfix/facturacion-timeout-sifen
```

1. Crear PR de `hotfix/facturacion-timeout-sifen` → `master`
2. CI corre, reviewer aprueba, merge
3. Semantic-release genera version de produccion
4. Deploy manual a produccion

**Inmediatamente despues:** Crear otro PR de `master` → `develop` para que develop tenga el fix. **Nunca dejar un hotfix solo en `master`.** El proximo merge a `develop` perderia el fix sino.

---

## 8. Desktop: como funciona el auto-update

### Flujo de actualizacion

```
App inicia → lee canal de config (alpha/beta/stable)
           → checkForUpdates() al servidor de GitHub
           → si hay update: descarga automaticamente
           → dialogo: "Cerrar y actualizar" / "Mas tarde"
           → si acepta: quitAndInstall() → NSIS instala → app reinicia
           → check automatico cada 5 minutos
```

### Canal de actualizacion

El canal se configura en **Configuracion → Canal de actualizacion**. Opciones:

| Canal | Que recibe | Quien lo usa |
|---|---|---|
| `alpha` | Cada merge a `develop` con `feat:` o `fix:` | Equipo interno, testing |
| `beta` | Cada merge a `release/beta` | Filial piloto |
| `stable` | Cada merge a `master` | Produccion |
| `dev` | Nada — auto-update desactivado | Desarrollo local |

### Detalles tecnicos relevantes

- El instalador se llama `FRC-Setup.exe` (con guion, sin espacios). **No cambiar el `artifactName` en `electron-builder.json`** sin verificar que el nombre coincide en el manifest YAML y en GitHub Release.
- La configuracion de canal se persiste en `%AppData%/FRC/config/config-backup.json` via IPC al main process.
- El zoom del usuario se persiste en `%AppData%/FRC/config/zoom-level.json`.
- Los logs de electron estan en `%AppData%/FRC/logs/main.log` — util para diagnosticar problemas de auto-update.

### Nombres de artefactos — NO CAMBIAR

| Artefacto | Nombre | Razon |
|---|---|---|
| Instalador Windows | `FRC-Setup.exe` | electron-updater lo busca por este nombre en el manifest |
| AppImage Linux | `FRC.AppImage` | electron-updater lo busca por este nombre |
| Manifests | `alpha.yml`, `latest.yml`, etc. | electron-updater los usa para detectar versiones |

---

## 9. Flujo visual completo

```
Developer                     GitHub                       Servidor
─────────                     ──────                       ────────

crear branch ───────────►

commit + push ──────────►

crear PR ───────────────►   CI ejecuta tests
                            ✓ verde / ✗ rojo

                            reviewer aprueba

merge a develop ────────►   semantic-release
                            → crea tag + release
                            → adjunta artefacto
                            (NO despliega solo)

deploy manual ──────────►   workflow descarga
(Actions → Run)              artefacto del release ────────► copia JAR/APK
                                                            reinicia servicio
                            aprobacion si es                health check
                            production                      ✓ OK / ✗ rollback
```

---

## 10. Comandos frecuentes

```bash
# === Iniciar trabajo ===
git checkout develop
git pull origin develop
git checkout -b feature/modulo-descripcion

# === Trabajar ===
git add archivo1.java archivo2.java
git commit -m "feat(modulo): descripcion del cambio"

# === Subir ===
git push -u origin feature/modulo-descripcion
# Ir a GitHub → crear PR hacia develop

# === Despues del merge ===
git checkout develop
git pull origin develop
git branch -d feature/modulo-descripcion

# === Actualizar develop local ===
git checkout develop
git pull origin develop

# === Mi branch quedo desactualizada ===
git checkout feature/modulo-descripcion
git merge develop
# Resolver conflictos si los hay
git push

# === Deshacer un merge a develop ===
git checkout develop
git revert -m 1 <hash-del-merge-commit>
git push origin develop
```

---

## 11. Errores comunes

### "commitlint rechaza mi commit"

Verificar:
- Tiene tipo? (`feat:`, `fix:`, etc.)
- Despues de `:` hay un espacio?
- La descripcion empieza en minuscula?
- No tiene punto final?

### "CI falla en mi PR"

1. Click en "Details" del check rojo
2. Leer el log para identificar el error
3. Corregir en tu branch, commit, push — el CI se re-ejecuta automaticamente

### "No se genero release despues del merge"

Los commits solo tenian tipos que no generan version (`chore`, `refactor`, `ci`, etc.). Es normal. Para generar release, al menos un commit debe ser `feat` o `fix`.

### "Merge bloqueado — requires status checks"

El CI no paso o no hay reviewer aprobado. Verificar ambos en el PR.

### "Conflicto al mergear"

```bash
git checkout feature/mi-branch
git merge develop
# Resolver conflictos en los archivos marcados
git add archivos-resueltos
git commit -m "chore: resolver conflictos con develop"
git push
```

---

## 12. Checklists

### Antes de abrir PR (developer)

- [ ] Mi rama sale de `develop` (o `master` si es hotfix)
- [ ] Commits siguen formato `tipo(scope): descripcion`
- [ ] Probe localmente (compile, tests basicos)
- [ ] Si toca DB: migracion versionada, aditiva, probada
- [ ] Si toca API: verificar que no rompe desktop/mobile
- [ ] Descripcion del PR incluye: que resuelve, como probarlo, riesgo, impacto DB/rollback

### Antes de aprobar (reviewer)

- [ ] El cambio resuelve el problema declarado
- [ ] No rompe compatibilidad de API/DB sin plan de 2 versiones
- [ ] Rollback es posible si algo falla
- [ ] No hay secretos ni archivos sensibles
- [ ] PR es de tamanio razonable (< 400 lineas idealmente)

### Antes de deploy a produccion

- [ ] Version especifica seleccionada (no "la ultima")
- [ ] Version validada en alpha o beta
- [ ] Backup de DB confirmado
- [ ] Responsable on-call disponible
- [ ] No es viernes

### Despues de deploy a produccion

- [ ] Health check responde OK (`/actuator/health`)
- [ ] Smoke test funcional minimo
- [ ] Monitorear logs los primeros 30 minutos

---

## 13. Lo que NUNCA debes hacer

1. Push directo a `master` o `develop` — siempre via PR
2. `git push --force` a ramas compartidas
3. Modificar migraciones de Flyway ya aplicadas
4. `DROP TABLE/COLUMN` sin la estrategia de 2 versiones
5. Commitear secretos (`.env`, keystores, tokens, passwords)
6. Squash merge en PRs — usar merge commit
7. Deploy a produccion sin aprobacion
8. Deploy los viernes (durante el periodo de adopcion)
9. Saltear el CI — si falla, corregir, no buscar bypass
10. Cambiar nombre de artefactos (`frc-central-server.jar`, `frc-filial-server.jar`) sin coordinar

---

## 14. Glosario

| Termino | Que es |
|---|---|
| **CI** | Continuous Integration — tests automaticos en cada PR |
| **CD** | Continuous Delivery — releases automaticos, deploys manuales |
| **PR** | Pull Request — solicitud para mergear tu branch |
| **Release** | Version publicada en GitHub con artefactos (JAR, EXE, APK) |
| **Deploy** | Instalar un release en un servidor o tienda de apps |
| **semantic-release** | Herramienta que lee commits y decide la version automaticamente |
| **Flyway** | Herramienta que ejecuta migraciones de DB al arrancar la app |
| **branch protection** | Regla de GitHub que impide push directo a ramas protegidas |
| **health check** | Endpoint `/actuator/health` que verifica si la app funciona |
| **rollback** | Volver a la version anterior si algo falla |
| **alpha** | Canal de pruebas internas (merge a develop) |
| **beta** | Canal de pruebas en piloto (merge a release/beta) |
| **production** | Canal de produccion (merge a master) |
| **scope** | Modulo o area del sistema en un commit: `feat(ventas):` |
| **breaking change** | Cambio que rompe compatibilidad con versiones anteriores |

---

## Regla final

> Si hay duda entre "rapido" y "seguro", elegir **seguro y reversible**. La velocidad real del equipo mejora cuando produccion se mantiene estable.
