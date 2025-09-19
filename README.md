# Zaper Canvas Backend

Node.js/Express API for ClickHouse database operations. Main file: `server.js`

## Setup
- `npm install && npm run dev`
- Uses ClickHouse on port 8123, serves on port 3001
- Environment: `.env` file with CLICKHOUSE_* credentials

## Architecture
- **server.js** - Main Express server with all routes
- **services/clickhouse-service.js** - ClickHouse client wrapper
- Provides table listing, data querying, analytics, and custom SELECT execution

## Key Endpoints
- `/api/tables` - List ClickHouse tables
- `/api/tables/:name/data` - Query table data (pagination, search, filters, sort)
- `/api/query` - Execute custom SELECT statements
