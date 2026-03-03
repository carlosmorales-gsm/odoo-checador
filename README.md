# Odoo Checador — Servicio de Sincronización ZKTeco ↔ Odoo

Servicio en Node.js que sincroniza dispositivos biométricos ZKTeco con el módulo de Asistencia de Odoo 17. Gestiona dos procesos automáticos: **enrollment** de empleados nuevos y **sincronización de checadas** (entrada/salida).

---

## Tabla de Contenidos

- [Arquitectura General](#arquitectura-general)
- [Modelo de Datos](#modelo-de-datos)
- [Requisitos Previos](#requisitos-previos)
- [Instalación](#instalación)
- [Configuración](#configuración)
- [Procesos Automáticos](#procesos-automáticos)
- [Scripts Manuales](#scripts-manuales)
- [Guía de Inicio Rápido](#guía-de-inicio-rápido)
- [Despliegue en Producción](#despliegue-en-producción)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Resolución de Problemas](#resolución-de-problemas)

---

## Arquitectura General

```
┌─────────────┐      XML-RPC       ┌─────────────┐
│   Odoo 17   │◄───────────────────►│             │
│ (Empleados  │                     │   Servicio  │
│  Asistencia)│                     │   Node.js   │
└─────────────┘                     │             │
                                    │  ┌────────┐ │
┌─────────────┐      TCP/4370      │  │ SQLite │ │
│  ZKTeco #1  │◄───────────────────►│  │ Estado │ │
│  (F22ID)    │                     │  └────────┘ │
└─────────────┘                     │             │
                                    │  ┌────────┐ │
┌─────────────┐      TCP/4370      │  │  Cron  │ │
│  ZKTeco #2  │◄───────────────────►│  │ Jobs   │ │
│  (F22ID)    │                     │  └────────┘ │
└─────────────┘                     └─────────────┘
```

El servicio actúa como puente bidireccional:

- **Odoo → ZKTeco**: Registra empleados nuevos en los checadores (enrollment)
- **ZKTeco → Odoo**: Lee registros de asistencia y crea check-in/check-out en Odoo

**Fuente de verdad:** La lista de empleados y usuarios en los checadores proviene únicamente de Odoo. No se sincronizan usuarios entre dispositivos; cada checador se actualiza desde Odoo mediante el proceso de enrollment (manual o automático).

### Stack Tecnológico

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 20 |
| Comunicación Odoo | XML-RPC (`xmlrpc`) |
| Comunicación ZKTeco | TCP binario (`zkteco-js`) |
| Base de datos local | SQLite (`better-sqlite3`) |
| Programación | Cron (`node-cron`) |
| Logging | Winston |
| Configuración | dotenv |
| Contenedores | Docker + Docker Compose |

---

## Modelo de Datos

### Mapeo Odoo ↔ ZKTeco

```
Odoo employee.id  ═══►  ZKTeco userid   (identificador lógico)
ZKTeco uid        ═══►  Odoo barcode    (slot interno del dispositivo)
```

| Campo Odoo | Campo ZKTeco | Descripción |
|---|---|---|
| `employee.id` | `userid` | ID lógico del empleado. Se usa para vincular las checadas. |
| `employee.barcode` | `uid` | Slot interno asignado por el dispositivo. Se escribe en Odoo como referencia. |
| `employee.name` | `name` | Nombre completo (máximo 24 caracteres en ZKTeco). |

### Base de Datos Local (SQLite)

**`sync_state`** — Controla hasta dónde se ha sincronizado cada dispositivo.

| Columna | Tipo | Descripción |
|---|---|---|
| `device_ip` | TEXT (PK) | IP del dispositivo |
| `last_synced_timestamp` | TEXT | Último timestamp procesado |

**`sync_log`** — Registro de auditoría de cada operación.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | INTEGER (PK) | Autoincremental |
| `device_ip` | TEXT | IP del dispositivo origen |
| `zk_user_id` | TEXT | ID del usuario en ZKTeco |
| `timestamp` | TEXT | Timestamp del evento |
| `action` | TEXT | `check_in` o `check_out` |
| `odoo_attendance_id` | INTEGER | ID de la asistencia creada en Odoo |
| `synced_at` | TEXT | Momento de la sincronización |

---

## Requisitos Previos

1. **Node.js 20+** (o Docker)
2. **Odoo 17** con módulo de Asistencia (`hr_attendance`) instalado
3. **API Key de Odoo** (Ajustes → Usuarios → seleccionar usuario → pestaña "Cuenta" → API Keys)
4. **Dispositivos ZKTeco** accesibles por red TCP en el puerto 4370
5. Conectividad de red entre el servidor, Odoo y los dispositivos ZKTeco

---

## Instalación

```bash
git clone <repositorio>
cd odoo-checador
npm install
cp .env.example .env
# Editar .env con tus valores reales
```

---

## Configuración

Editar el archivo `.env`:

```env
# ── Conexión a Odoo ──────────────────────────────────────────────────
ODOO_URL=https://mi-empresa.odoo.com
ODOO_DB=mi-empresa-produccion
ODOO_USER=usuario@empresa.com
ODOO_API_KEY=tu-api-key-aqui

# ── Dispositivos ZKTeco (JSON array) ─────────────────────────────────
ZKTECO_DEVICES=[{"name":"Oficina Principal","ip":"192.168.1.100","port":4370}]

# ── Intervalos ────────────────────────────────────────────────────────
SYNC_INTERVAL=*/30 * * * *       # Sync de asistencia cada 30 minutos
ENROLL_INTERVAL=0 8 * * 2        # Enrollment cada martes a las 8am
TIMEZONE=America/Mexico_City

# ── TLS (solo para instancias .dev.odoo.com) ─────────────────────────
# NODE_TLS_REJECT_UNAUTHORIZED=0

# ── Otros ─────────────────────────────────────────────────────────────
LOG_LEVEL=info
# Optional: file logging with rotation (e.g. on Raspberry Pi)
# LOG_PATH=/var/log/odoo-checador/app.log
# LOG_MAX_SIZE=10m
# LOG_MAX_FILES=7d
HEALTH_PORT=3000
```

### Variables de Entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `ODOO_URL` | Sí | — | URL de la instancia Odoo |
| `ODOO_DB` | Sí | — | Nombre de la base de datos |
| `ODOO_USER` | Sí | — | Email del usuario con acceso API |
| `ODOO_API_KEY` | Sí | — | API Key generada en Odoo |
| `ZKTECO_DEVICES` | Sí | — | JSON array con `name`, `ip`, `port` de cada dispositivo |
| `SYNC_INTERVAL` | No | `*/30 * * * *` | Expresión cron para sync de asistencia |
| `ENROLL_INTERVAL` | No | `0 8 * * 2` | Expresión cron para enrollment semanal |
| `TIMEZONE` | No | `America/Mexico_City` | Zona horaria de los dispositivos |
| `CRON_ENABLED` | No | `true` | `0` o `false` para desactivar crons (sync y enrollment automáticos); el health check sigue activo |
| `LOG_LEVEL` | No | `info` | Nivel de log: `debug`, `info`, `warn`, `error` |
| `LOG_PATH` | No | — | Si se define, se escribe log a archivo con rotación (ej. `/var/log/odoo-checador/app.log`) |
| `LOG_MAX_SIZE` | No | `10m` | Tamaño máximo por archivo antes de rotar (ej. `20m`) |
| `LOG_MAX_FILES` | No | `7d` | Retención: días (ej. `14d`) o número de archivos (ej. `5`) |
| `HEALTH_PORT` | No | `3000` | Puerto del health check HTTP |
| `DB_PATH` | No | `./sync-state.db` | Ruta de la base SQLite |
| `NODE_TLS_REJECT_UNAUTHORIZED` | No | — | Poner a `0` solo para instancias `.dev.odoo.com` |

### Múltiples Dispositivos

Para configurar varios checadores, agregar al JSON array:

```json
ZKTECO_DEVICES=[
  {"name":"Oficina Principal","ip":"192.168.1.100","port":4370},
  {"name":"Planta Baja","ip":"192.168.1.101","port":4370},
  {"name":"Sucursal Norte","ip":"10.0.5.200","port":4370}
]
```

El servicio sincroniza asistencia de **todos** los dispositivos y registra empleados nuevos en **todos** los dispositivos.

---

## Procesos Automáticos

Al ejecutar `npm start`, el servicio arranca dos cron jobs:

### 1. Sincronización de Asistencia (cada 30 min)

```
ZKTeco → Lee logs → Filtra nuevos → Busca empleado en Odoo → Check-in / Check-out
```

**Lógica de toggle entrada/salida:**

Los dispositivos ZKTeco no distinguen entre entrada y salida. El servicio implementa la lógica de toggle:

- Si el empleado **no tiene** asistencia abierta → crea **check-in**
- Si el empleado **tiene** asistencia abierta (sin check-out) → cierra con **check-out**

**Flujo detallado:**

1. Se conecta a cada dispositivo ZKTeco por TCP
2. Lee todos los registros de asistencia
3. Filtra solo los posteriores al último timestamp sincronizado (control incremental via SQLite)
4. Para cada registro nuevo:
   - Busca el empleado en Odoo usando `employee.id = log.userId`
   - Convierte el timestamp de hora local a UTC
   - Consulta si hay asistencia abierta → decide check-in o check-out
   - Registra la operación en `sync_log`
5. Actualiza `last_synced_timestamp` en SQLite

### 2. Enrollment de Empleados (cada martes a las 8am)

```
Odoo (empleados sin barcode) → Registra en ZKTeco → Escribe barcode en Odoo
```

**Flujo detallado:**

1. Lee todos los empleados de Odoo
2. Filtra los que **no tienen barcode** (empleados nuevos)
3. Para cada empleado nuevo:
   - Lo registra en **todos** los dispositivos ZKTeco con `userid = employee.id`
   - El dispositivo asigna un `uid` secuencial (slot interno)
   - Escribe ese `uid` como `barcode` en Odoo
4. En el siguiente ciclo, ese empleado ya no aparece como pendiente

### Health Check y API HTTP

El servicio expone un servidor HTTP en el puerto configurado (`HEALTH_PORT`, por defecto 3000). Endpoints disponibles:

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio y flags `syncing` / `enrolling` |
| GET | `/api/logs` | Últimos logs en memoria (para diagnóstico sin SSH) |
| GET | `/api/sync-state` | Estado de sincronización por dispositivo (IP y último timestamp) |
| GET | `/api/sync-log` | Registro de auditoría de checadas sincronizadas |
| GET | `/api/stats` | Estadísticas: total, hoy, por acción, por dispositivo |
| GET | `/` o `/console` | Consola web con estadísticas y últimos registros |

**Comandos útiles (reemplaza `localhost:3000` por la IP del Pi si consultas desde otra máquina):**

```bash
# Estado del servicio
curl http://localhost:3000/health

# Logs recientes (JSON, últimas 500 entradas)
curl http://localhost:3000/api/logs

# Logs en texto plano, últimas 200 líneas (fácil de leer o guardar)
curl "http://localhost:3000/api/logs?limit=200&format=text"

# Estado de cada dispositivo (último sync)
curl http://localhost:3000/api/sync-state

# Últimos registros de sync (check-in/check-out)
curl "http://localhost:3000/api/sync-log?limit=50"

# Estadísticas agregadas
curl http://localhost:3000/api/stats
```

**Parámetros opcionales de `/api/logs`:**

| Parámetro | Descripción | Ejemplo |
|-----------|-------------|---------|
| `limit` | Número de entradas (máx. 2000) | `?limit=100` |
| `format` | `text` para texto plano, uno por línea | `?format=text` |

El buffer de logs guarda las últimas 2000 entradas desde el arranque del proceso; no depende de `LOG_PATH`.

---

## Scripts Manuales

Todos los scripts están en la carpeta `scripts/` y se ejecutan desde la raíz del proyecto.

### Enrollment Manual

```bash
# Preview: muestra qué empleados se registrarían
node scripts/enroll-employees.js --dry-run

# Ejecución real: registra empleados en ZKTeco y escribe barcode en Odoo
node scripts/enroll-employees.js
```

### Dry-Runs (solo lectura)

```bash
# Enrollment — Cruce completo Odoo vs ZKTeco con plan detallado
node scripts/dry-run-enrollment.js

# Asistencia — Qué checadas se sincronizarían
node scripts/dry-run-attendance.js

# Reprovisionado — Qué dispositivos se considerarían "nuevos" y qué pasos se ejecutarían (clear → usuarios Odoo → huellas)
node scripts/dry-run-reprovision.js
# Solo un dispositivo:
node scripts/dry-run-reprovision.js --device "Oficina Principal"
```

### Respaldo de Huellas

```bash
# Todas las huellas de todos los dispositivos
node scripts/backup-fingerprints.js

# Solo un dispositivo específico
node scripts/backup-fingerprints.js --device "Oficina Principal"
```

Los respaldos se guardan en `fingerprints/` con formato:

```
fingerprints/
  782-martinez-mendez-juan-cristobal.json
  783-andrade-gutierrez-enrique.json
  ...
```

### Otros scripts

```bash
# Ejecutar un solo ciclo de sincronización de asistencia (sin esperar al cron)
node scripts/run-sync.js

# Restaurar usuarios en dispositivos desde un respaldo previo
node scripts/restore-device-users.js

# Limpiar datos de un dispositivo ZKTeco (usuarios/asistencia). Uso avanzado.
node scripts/clear-device.js --device "Oficina Principal"
```

---

## Guía de Inicio Rápido

### Paso 1: Configurar `.env`

Completar las credenciales de Odoo y las IPs de los dispositivos ZKTeco.

### Paso 2: Verificar conectividad

```bash
# Verificar que Odoo y ZKTeco responden
node scripts/dry-run-enrollment.js
```

Debe mostrar la lista de empleados de Odoo y el estado de cada dispositivo ZKTeco.

### Paso 3: Preview de enrollment

```bash
node scripts/enroll-employees.js --dry-run
```

Revisar que los empleados mostrados son correctos y que el plan de asignación de IDs es el esperado.

### Paso 4: Ejecutar enrollment real

```bash
node scripts/enroll-employees.js
```

Esto registra los empleados en los checadores y escribe los barcodes en Odoo. **No se puede deshacer fácilmente**, por eso siempre hacer dry-run primero.

### Paso 5: Verificar resultado

```bash
node scripts/dry-run-enrollment.js
```

Ahora debería mostrar que todos los empleados tienen barcode y están en los dispositivos.

### Paso 6: Arrancar el servicio

```bash
npm start
```

El servicio comienza a sincronizar asistencia cada 30 minutos y ejecuta enrollment automático cada martes a las 8am.

### Paso 7: Respaldar huellas (opcional)

Una vez que los empleados ya registraron sus huellas en los dispositivos:

```bash
node scripts/backup-fingerprints.js
```

---

## Despliegue en Producción

### Con Docker (recomendado)

```bash
docker compose up -d
```

La base de datos SQLite se persiste en un volumen Docker (`sync-data`).

### Con Docker manual

```bash
docker build -t odoo-checador .
docker run -d --name checador \
  --env-file .env \
  -p 3000:3000 \
  -v checador-data:/data \
  --restart unless-stopped \
  odoo-checador
```

### Con systemd (Raspberry Pi / servidor Linux)

Consultar el archivo `SETUP-RASPBERRY-PI.md` para instrucciones detalladas.

### Verificar que está corriendo

```bash
curl http://localhost:3000/health
# → {"status":"ok","syncing":false}
```

---

## Estructura del Proyecto

```
odoo-checador/
├── src/
│   ├── index.js                 # Entry point: crons, health check, shutdown
│   ├── config.js                # Carga y valida variables de entorno
│   ├── logger.js                # Logger centralizado (consola + archivo opcional con rotación)
│   ├── db/
│   │   └── state.js             # SQLite: sync_state, sync_log
│   ├── odoo/
│   │   └── client.js            # Cliente XML-RPC para Odoo
│   ├── sync/
│   │   ├── attendance.js        # Lógica de sync de asistencia
│   │   └── enrollment.js        # Lógica de enrollment automático
│   └── zkteco/
│       └── client.js            # Wrapper de comunicación ZKTeco
├── scripts/
│   ├── dry-run-enrollment.js    # Preview cruce Odoo ↔ ZKTeco
│   ├── dry-run-attendance.js    # Preview de checadas pendientes
│   ├── dry-run-reprovision.js   # Preview reprovisionado (checador nuevo: clear → Odoo → huellas)
│   ├── enroll-employees.js      # Enrollment manual (--dry-run / real)
│   ├── backup-fingerprints.js   # Respaldo de huellas digitales
│   ├── run-sync.js              # Ejecuta un ciclo de sync de asistencia (sin cron)
│   ├── restore-device-users.js  # Restaura usuarios en dispositivos desde respaldo
│   └── clear-device.js          # Limpia usuarios/asistencia de un dispositivo (uso avanzado)
├── fingerprints/                # Respaldos de huellas (gitignored)
├── patches/                     # Parches a dependencias (patch-package)
│   └── zkteco-js+1.7.1.patch   # Soporte F22ID: templates por chunks (CMD 1500)
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

No se versionan (ver `.gitignore`): `node_modules/`, `.env`, `logs/`, `*.db`, `fingerprints/`, reportes generados y archivos de IDE/OS.

La carpeta `patches/` sí se versiona. Tras `npm install`, los parches se aplican con `patch-package` (script postinstall). El parche de `zkteco-js` añade soporte para F22ID que responden CMD 1500 al pedir templates de huella (lectura por chunks).

### Módulos Principales

**`src/odoo/client.js`** — Cliente XML-RPC con métodos:

| Método | Descripción |
|---|---|
| `authenticate()` | Autenticación con API Key |
| `getAllEmployees(fields)` | Lista todos los empleados |
| `getEmployeeById(id)` | Busca empleado por ID directo |
| `setEmployeeBarcode(id, barcode)` | Escribe barcode en un empleado |
| `getLastOpenAttendance(employeeId)` | Busca asistencia sin check-out |
| `createCheckIn(employeeId, timestamp)` | Crea registro de entrada |
| `updateCheckOut(attendanceId, timestamp)` | Cierra registro con salida |

**`src/zkteco/client.js`** — Comunicación TCP con métodos:

| Método | Descripción |
|---|---|
| `getDeviceInfo(config)` | Info del dispositivo (usuarios, logs, capacidad) |
| `getAttendanceLogs(config)` | Lee registros de asistencia |
| `getUsers(config)` | Lista usuarios registrados |
| `setUser(config, userData)` | Registra un usuario |
| `getUserFingerprints(config, uid)` | Lee templates de huellas (10 dedos) |

---

## Resolución de Problemas

### Error: `Odoo RPC error: Hostname/IP does not match certificate's altnames`

Instancias `.dev.odoo.com` usan certificados que no coinciden con el hostname. Agregar a `.env`:

```
NODE_TLS_REJECT_UNAUTHORIZED=0
```

En producción con dominio propio, **no usar esta variable**.

### Error: `TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA`

El dispositivo ZKTeco no responde a tiempo. Verificar:

1. Que el dispositivo es accesible: `ping <ip>`
2. Que el puerto TCP 4370 está abierto
3. Que no hay otro software conectado al dispositivo simultáneamente

### Error: `Odoo authentication failed: invalid credentials`

La API Key es incorrecta o pertenece a otra instancia. Generar una nueva en:

Odoo → Ajustes → Usuarios → seleccionar usuario → pestaña "Cuenta" → API Keys

### Dispositivo vacío causa crash

Si `getUsers` o `getAttendanceLogs` fallan en un dispositivo con 0 registros, el servicio lo maneja automáticamente retornando un array vacío.

### Los timestamps no coinciden

Verificar que `TIMEZONE` en `.env` coincide con la zona horaria configurada en los dispositivos ZKTeco. El servicio convierte de hora local a UTC antes de enviar a Odoo.
