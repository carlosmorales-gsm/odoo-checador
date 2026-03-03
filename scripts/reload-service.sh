#!/bin/bash
# Detiene odoo-checador, instala dependencias (npm install) y vuelve a iniciar el servicio.
set -e
cd "$(dirname "$0")/.."

echo "Deteniendo odoo-checador..."
sudo systemctl stop odoo-checador

echo "Instalando dependencias (npm install)..."
npm install

echo "Iniciando odoo-checador..."
sudo systemctl start odoo-checador

echo "Listo. Estado:"
sudo systemctl status odoo-checador --no-pager
