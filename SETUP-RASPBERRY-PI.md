# Setup en Raspberry Pi

## Requisitos

- Raspberry Pi 2B+ o superior (recomendado: Pi 4 o Pi 5)
- Raspberry Pi OS (64-bit recomendado)
- Conectado a la misma LAN que los checadores ZKTeco
- Acceso SSH habilitado

## 1. Instalar Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node -v  # debe mostrar v20.x.x
```

## 2. Instalar dependencias del sistema

`better-sqlite3` necesita compilar código nativo:

```bash
sudo apt-get install -y build-essential python3
```

## 3. Clonar o copiar el proyecto

```bash
# Opción A: desde git
git clone <tu-repo> /home/pi/odoo-checador
cd /home/pi/odoo-checador

# Opción B: copiar desde tu Mac via SCP
# (desde tu Mac):
# scp -r "/Users/cmgsm/Desarrollo GSM/odoo-checador" pi@<IP_PI>:/home/pi/odoo-checador
```

## 4. Instalar dependencias

```bash
cd /home/pi/odoo-checador
npm install
```

## 5. Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

Llenar con tus valores reales:

```
ODOO_URL=https://tu-empresa.odoo.com
ODOO_DB=tu-base-de-datos
ODOO_USER=integracion@empresa.com
ODOO_API_KEY=tu-api-key
ZKTECO_DEVICES=[{"name":"Entrada Principal","ip":"10.1.20.30","port":4370}]
SYNC_INTERVAL=*/5 * * * *
TIMEZONE=America/Mexico_City
LOG_LEVEL=info
HEALTH_PORT=3000
```

## 6. Probar conexión al checador

```bash
node test-zkteco.js
```

Debes ver la lista de usuarios y registros de asistencia.

## 7. Probar el servicio

```bash
npm start
```

Verifica que sincronice correctamente. Detener con `Ctrl+C`.

## 8. Configurar como servicio (inicio automático)

Crear el archivo de servicio systemd:

```bash
sudo nano /etc/systemd/system/odoo-checador.service
```

Pegar este contenido:

```ini
[Unit]
Description=ZKTeco → Odoo Attendance Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/odoo-checador
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Habilitar e iniciar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable odoo-checador
sudo systemctl start odoo-checador
```

## 9. Comandos útiles

```bash
# Ver estado
sudo systemctl status odoo-checador

# Ver logs en tiempo real
journalctl -u odoo-checador -f

# Reiniciar
sudo systemctl restart odoo-checador

# Detener
sudo systemctl stop odoo-checador
```

## 10. Verificar health check

Desde el mismo Pi o cualquier máquina en la LAN:

```bash
curl http://localhost:3000/health
# {"status":"ok","syncing":false}
```

## Notas

- La base de datos SQLite se guarda en `sync-state.db` dentro del proyecto
- Si el Pi se reinicia, el servicio arranca solo
- Los logs se pueden ver con `journalctl`
- El servicio consume menos de 100MB de RAM
