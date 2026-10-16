# Use official lightweight Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code and public assets
COPY server.js ./
COPY public/ ./public/

# Use non-root node user for security
USER node

# Expose web service port
EXPOSE 3000

# Start web application
CMD ["node", "server.js"]
