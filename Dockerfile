# LegoCollector Docker Image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production && npm cache clean --force

# Copy application files
COPY . .

# Create directory for uploads if not exists
RUN mkdir -p uploads

# Expose port
EXPOSE 3000

# Set environment variable
ENV NODE_ENV=production

# Start application
CMD ["npm", "start"]
