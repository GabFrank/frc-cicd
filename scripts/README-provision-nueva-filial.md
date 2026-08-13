# provision-nueva-filial.sh — Provisioning de DB para filial nueva

Siembra la base `general` de una **filial nueva** con **solo datos maestros**, dejando las tablas **operativas por-sucursal vacías**. Reemplaza al viejo `frc-comercial/desktop/restauracion_filial_25.sql`.

## Por qué existe

El `restauracion_filial_25.sql` **no excluía** las operativas: las copiaba filtradas por `WHERE sucursal_id = 25` (era un *rebuild* de una sucursal existente, no un provisioning limpio). Estaba hardcodeado (sucursal 25, IPs ZeroTier, password en claro) y cargaba por niveles con `dblink` resolviendo FKs a mano.

Este script:
- Usa **`pg_dump -Fc` + `--exclude-table-data`** → la tabla operativa se crea (schema) pero **sin filas**. `pg_restore` crea las constraints después de la data, así que las **dependencias circulares** (`persona`↔`usuario`) se resuelven solas — sin los `UPDATE` manuales del script viejo.
- Toda conexión PG es **local vía SSH** en cada host (dump en el central sobre localhost, restore en la filial sobre localhost) → **evita pg_hba y la red overlay entre hosts**.
- `--source-host central` usa el **nombre MagicDNS de headscale** (no `172.25.1.200` ni la IP pública).
- Deriva la lista de exclusión **viva** desde la publicación real (`--from-publication`), o usa la lista por defecto (27 tablas).

## Clasificación maestro vs operativo

| Copiar (maestro) | Dejar VACÍAS (operativas por-sucursal) |
|---|---|
| pais, ciudad, persona, usuario, funcionario, sucursal, cargo, banco, moneda, timbrado, cambio, familia, subfamilia, producto, presentacion, tipo_precio, **precio_por_sucursal** (todas las sucursales), **costo_por_producto**, forma_pago, pedido, local, … | marcacion, inicio_sesion, cambio_caja, conteo, conteo_moneda, factura_legal, factura_legal_item, gasto, gasto_detalle, maletin, movimiento_caja, pdv_caja, retiro, retiro_detalle, sencillo, sencillo_detalle, venta_credito, venta_credito_cuota, cobro, cobro_detalle, delivery, movimiento_stock, stock_por_producto_sucursal, venta, venta_item, vuelto, vuelto_item |

La columna derecha = las **27 tablas** de `central_filial25_pub` (el set replicado central↔filial). **Fuente de verdad viva:** la publicación en el central. Pasá `--from-publication central_filialN_pub` para derivarla en runtime en vez de confiar en la lista horneada.

## Uso

```bash
./provision-nueva-filial.sh \
  --source-host central --source-user franco --source-pg-port 5551 --source-db farmacia \
  --target-host 192.168.0.156 --target-user franco --target-pg-port 5432 --target-db general \
  --sucursal-id 30 \
  --from-publication central_filial5_pub \   # opcional: lista de exclusión viva
  --dry-run                                  # imprime el plan sin tocar nada
```

Quitá `--dry-run` para ejecutar (pide confirmación; `--yes` la saltea).

### Requisitos
- SSH sin password a source y target (clave ya instalada).
- `pg_dump`/`pg_restore` en source, `pg_restore`/`psql` en target.
- `sudo -u postgres psql` funcional en ambos (peer auth) — o ajustar `--pg-superuser`.
- La **sucursal ya debe existir** en `empresarial.sucursal` del central (es dato maestro; el script lo valida y aborta si falta).

## Fases del script
0. **Preflight** — binarios, conectividad, sucursal existe en el maestro.
1. **Dump** en el source (maestro + schema completo, operativas con `--exclude-table-data`, `--no-publications --no-subscriptions`, solo los 10 schemas de filial).
2. **Transferencia** source → relay local → target.
3. **Restore** — backup previo de la DB target si existe, DROP/CREATE, `pg_restore`.
4. **Verificación** — operativas = 0 filas, maestro > 0, sucursal presente.

## Lo que NO hace (pasos manuales posteriores)
- **No** configura replicación lógica → imprime los comandos (`CREATE PUBLICATION` / `CREATE SUBSCRIPTION` con `host=central`).
- **No** setea el `application.properties` overlay (`sucursalId`, `ipServidorCentral=central:8082`) — ver [../runbook-migracion-filial-linux-beta.md](../runbook-migracion-filial-linux-beta.md).
