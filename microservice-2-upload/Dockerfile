# Use official lightweight Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY server.js ./

# Use non-root node user for security
USER node

# Expose microservice port
EXPOSE 8080

# Start upload service
CMD ["node", "server.js"]
