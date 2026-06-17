FROM node:20-slim

# Forzar rebuild - v5
RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p public/qr
RUN pip3 install qrcode pillow --break-system-packages
EXPOSE 3000
CMD ["node", "server.js"]
