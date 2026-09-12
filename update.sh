#!/bin/bash

# Foodiss Update Script
# This script updates the live server with the latest files and restarts the services.

set -e

echo "==========================================================="
echo "               Foodiss Update Script                       "
echo "==========================================================="

echo "[1/4] Updating Backend..."
cd Backend
npm install
echo "Restarting Backend with PM2..."
pm2 restart foodiss-backend || pm2 restart all
cd ..

echo "[2/4] Updating Frontend..."
cd Frontend
npm install
echo "Building Frontend..."
npm run build
cd ..

echo "[3/4] Deploying Frontend to Nginx..."
sudo rm -rf /var/www/foodiss/*
sudo cp -r Frontend/dist/* /var/www/foodiss/

echo "[4/4] Restarting Nginx..."
sudo systemctl restart nginx

echo "==========================================================="
echo "                Update Complete!                           "
echo "==========================================================="
echo "Your latest code is now live at https://foodissapp.com"
