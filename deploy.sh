#!/bin/bash

# Foodiss Deployment Script
# This script automates the deployment process for the Foodiss application.

set -e # Exit immediately if a command exits with a non-zero status.

echo "==========================================================="
echo "               Foodiss Deployment Script                   "
echo "==========================================================="

# 1. Update and install dependencies
echo "[1/8] Updating packages and installing nginx, git, curl..."
sudo apt update
sudo apt install nginx git curl -y

echo "[2/8] Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "[3/8] Installing PM2 globally..."
sudo npm install -g pm2

# 2. Setup Backend
echo "[4/8] Setting up Backend..."
cd Backend
npm i

# Prompt for backend env
echo "-----------------------------------------------------------"
echo "Please paste your Backend .env configuration."
echo "Press CTRL+D when you are done."
echo "-----------------------------------------------------------"
cat > .env

echo "Starting Backend with PM2..."
pm2 start server.js --name foodiss-backend
pm2 save
cd ..

# 3. Setup Frontend
echo "[5/8] Setting up Frontend..."
cd Frontend
npm i

# Prompt for frontend env
echo "-----------------------------------------------------------"
echo "Please paste your Frontend .env.production configuration."
echo "Press CTRL+D when you are done."
echo "-----------------------------------------------------------"
cat > .env.production

echo "Building Frontend..."
npm run build
cd ..

# 4. Configure Nginx
echo "[6/8] Configuring Nginx for Frontend..."
sudo mkdir -p /var/www/foodiss
sudo rm -rf /var/www/foodiss/*
sudo cp -r Frontend/dist/* /var/www/foodiss/

echo "Creating Nginx configuration..."
sudo tee /etc/nginx/sites-available/foodiss > /dev/null << 'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name foodissapp.com www.foodissapp.com;
    root /var/www/foodiss;
    index index.html;

    # FRONTEND
    location / {
        try_files $uri $uri/ /index.html;
    }

    # BACKEND API
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

echo "Enabling Nginx site..."
sudo ln -sf /etc/nginx/sites-available/foodiss /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

echo "Testing and restarting Nginx..."
sudo nginx -t
sudo systemctl restart nginx

# 5. SSL with Certbot
echo "[7/8] Installing Certbot..."
sudo apt install certbot python3-certbot-nginx -y

echo "[8/8] Generating SSL certificates..."
sudo certbot --nginx -d foodissapp.com -d www.foodissapp.com --non-interactive --agree-tos -m foodiss.service@gmail.com

echo "==========================================================="
echo "                Deployment Complete!                       "
echo "==========================================================="
echo "Your app should now be live at https://foodissapp.com"
