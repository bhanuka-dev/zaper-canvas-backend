require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const clickhouseService = require('./services/clickhouse-service');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy for Railway deployment
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutes default
  max: process.env.RATE_LIMIT_MAX || 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.CORS_ORIGIN
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Check if origin is in allowed list or is a vercel.app domain
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Initialize ClickHouse connection
async function initializeDatabase() {
  try {
    await clickhouseService.connect();
  } catch (error) {
    console.error('Failed to initialize ClickHouse connection:', error);
    // Don't exit the process, let the endpoints handle connection errors
  }
}

// Routes

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const dbStatus = await clickhouseService.ping();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbStatus.success ? 'connected' : 'disconnected',
      database_error: dbStatus.success ? null : dbStatus.error
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Get available tables
app.get('/api/tables', async (req, res) => {
  try {
    const tables = await clickhouseService.getTables();
    res.json({
      success: true,
      data: tables
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

// Get table schema
app.get('/api/tables/:tableName/schema', async (req, res) => {
  try {
    const { tableName } = req.params;
    const schema = await clickhouseService.getTableSchema(tableName);
    res.json({
      success: true,
      data: schema,
      tableName
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: [],
      tableName: req.params.tableName
    });
  }
});

// Get table data with pagination, search, sorting, and filtering
app.get('/api/tables/:tableName/data', async (req, res) => {
  try {
    const { tableName } = req.params;
    const {
      page = 1,
      pageSize = 5,
      search = '',
      sortField = '',
      sortDirection = 'ASC',
      columns = ''
    } = req.query;

    // Parse filters from query parameters
    const filters = {};
    Object.keys(req.query).forEach(key => {
      if (key.startsWith('filter_')) {
        const fieldName = key.replace('filter_', '');
        filters[fieldName] = req.query[key];
      }
    });

    // Parse columns if provided
    const columnsArray = columns ? columns.split(',').map(col => col.trim()) : ['*'];

    const result = await clickhouseService.getTableData({
      tableName,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      search,
      sortField,
      sortDirection: sortDirection.toUpperCase(),
      filters,
      columns: columnsArray
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: [],
      pagination: {
        page: 1,
        pageSize: 5,
        total: 0,
        totalPages: 0
      }
    });
  }
});

// Get analytics data for a table
app.get('/api/tables/:tableName/analytics', async (req, res) => {
  try {
    const { tableName } = req.params;
    const result = await clickhouseService.getAnalytics(tableName);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: {}
    });
  }
});

// Get distinct values for a column (for filters)
app.get('/api/tables/:tableName/columns/:columnName/values', async (req, res) => {
  try {
    const { tableName, columnName } = req.params;
    const { limit = 100 } = req.query;
    
    const result = await clickhouseService.getDistinctValues(
      tableName, 
      columnName, 
      parseInt(limit)
    );
    
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

// Execute custom query (POST for security)
app.post('/api/query', async (req, res) => {
  try {
    const { query, format = 'JSONEachRow' } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Query is required',
        data: []
      });
    }

    const result = await clickhouseService.executeCustomQuery(query, format);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

// Execute predefined query with pagination (for the frontend widget system)
app.post('/api/query/execute', async (req, res) => {
  try {
    const {
      query,
      format = 'JSONEachRow',
      page = 1,
      pageSize = 5,
      search = '',
      sortField = '',
      sortDirection = 'ASC',
      filters = {}
    } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Query is required',
        data: []
      });
    }

    // For predefined queries, we need to handle pagination and filtering
    let modifiedQuery = query;
    const offset = (page - 1) * pageSize;

    // Add WHERE clauses for search and filters if provided
    const conditions = [];

    if (search && search.trim() !== '') {
      // For daily_worker_summary table, search across main text fields
      // Use ILIKE for case-insensitive search and handle nulls
      const searchTerm = search.replace(/'/g, "''"); // Escape single quotes
      const searchCondition = `(
        lower(toString(client_name)) LIKE lower('%${searchTerm}%') OR
        lower(toString(staff_name)) LIKE lower('%${searchTerm}%') OR
        toString(work_date) LIKE '%${searchTerm}%' OR
        lower(toString(ifNull(leave_type, ''))) LIKE lower('%${searchTerm}%')
      )`;
      conditions.push(searchCondition);
    }

    Object.entries(filters || {}).forEach(([field, value]) => {
      if (value && value.toString().trim() !== '') {
        conditions.push(`toString(${field}) ILIKE '%${value}%'`);
      }
    });

    // If we have conditions, modify the query
    if (conditions.length > 0) {
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      // If query already has WHERE, we need to add AND
      if (modifiedQuery.toUpperCase().includes('WHERE')) {
        modifiedQuery = modifiedQuery.replace(/WHERE/i, `WHERE ${conditions.join(' AND ')} AND`);
      } else {
        // Add WHERE before ORDER BY if it exists, or before LIMIT
        if (modifiedQuery.toUpperCase().includes('ORDER BY')) {
          modifiedQuery = modifiedQuery.replace(/ORDER BY/i, `${whereClause} ORDER BY`);
        } else if (modifiedQuery.toUpperCase().includes('LIMIT')) {
          modifiedQuery = modifiedQuery.replace(/LIMIT/i, `${whereClause} LIMIT`);
        } else {
          modifiedQuery += ` ${whereClause}`;
        }
      }
    }

    // Add sorting if provided
    if (sortField) {
      if (modifiedQuery.toUpperCase().includes('ORDER BY')) {
        // Replace existing ORDER BY clause completely
        modifiedQuery = modifiedQuery.replace(/ORDER BY\s+\w+\s+(ASC|DESC)/i, `ORDER BY ${sortField} ${sortDirection.toUpperCase()}`);
      } else {
        if (modifiedQuery.toUpperCase().includes('LIMIT')) {
          modifiedQuery = modifiedQuery.replace(/LIMIT/i, `ORDER BY ${sortField} ${sortDirection.toUpperCase()} LIMIT`);
        } else {
          modifiedQuery += ` ORDER BY ${sortField} ${sortDirection.toUpperCase()}`;
        }
      }
    }

    // Add pagination
    if (modifiedQuery.toUpperCase().includes('LIMIT')) {
      // Replace existing LIMIT
      modifiedQuery = modifiedQuery.replace(/LIMIT \d+/i, `LIMIT ${pageSize} OFFSET ${offset}`);
    } else {
      modifiedQuery += ` LIMIT ${pageSize} OFFSET ${offset}`;
    }

    console.log('Executing modified query:', modifiedQuery);

    const result = await clickhouseService.executeCustomQuery(modifiedQuery, format);

    // Get total count for pagination (run original query with COUNT)
    let countQuery = query.replace(/SELECT.*?FROM/i, 'SELECT COUNT(*) as total FROM');
    // Remove ORDER BY and LIMIT from count query
    countQuery = countQuery.replace(/ORDER BY.*?(?=LIMIT|$)/i, '');
    countQuery = countQuery.replace(/LIMIT.*$/i, '');

    // Add WHERE conditions to count query
    if (conditions.length > 0) {
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      if (countQuery.toUpperCase().includes('WHERE')) {
        countQuery = countQuery.replace(/WHERE/i, `WHERE ${conditions.join(' AND ')} AND`);
      } else {
        countQuery += ` ${whereClause}`;
      }
    }

    const countResult = await clickhouseService.executeCustomQuery(countQuery, format);
    const total = countResult.data && countResult.data[0] ? countResult.data[0].total : 0;

    res.json({
      success: result.success,
      data: result.data || [],
      error: result.error,
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        total: parseInt(total),
        totalPages: Math.ceil(total / pageSize)
      },
      query: modifiedQuery
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: [],
      pagination: {
        page: 1,
        pageSize: 5,
        total: 0,
        totalPages: 0
      }
    });
  }
});

// Mock data endpoints for compatibility with existing frontend
// These simulate the structure your frontend expects
app.get('/api/queries', (req, res) => {
  res.json({
    success: true,
    data: [
      {
        id: 1,
        name: 'Database Query 1',
        description: 'Default database table query',
        tableName: 'daily_worker_summary'
      },
      // {
      //   id: 2,
      //   name: 'Database Query 2',
      //   description: 'Another database table query',
      //   tableName: 'another_table_name' 
      // }
    ]
  });
});

// Get query data by ID (for compatibility)
app.get('/api/queries/:queryId/data', async (req, res) => {
  try {
    const { queryId } = req.params;
    
    // This is a simple mapping - you'll need to customize this
    // based on your actual tables and requirements
    const tableMapping = {
      '1': 'daily_worker_summary',    // Replace with actual table name
      // '2': 'your_second_table'    // Replace with actual table name
    };
    
    const tableName = tableMapping[queryId];
    if (!tableName) {
      return res.status(404).json({
        success: false,
        error: 'Query not found',
        data: []
      });
    }

    const {
      page = 1,
      pageSize = 5,
      search = '',
      sortField = '',
      sortDirection = 'ASC'
    } = req.query;

    const result = await clickhouseService.getTableData({
      tableName,
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      search,
      sortField,
      sortDirection: sortDirection.toUpperCase()
    });

    // Transform the response to match your frontend expectations
    res.json({
      success: true,
      id: queryId,
      name: `Query ${queryId}`,
      data: result.data,
      pagination: result.pagination
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      data: [],
      pagination: {
        page: 1,
        pageSize: 5,
        total: 0,
        totalPages: 0
      }
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await clickhouseService.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Shutting down gracefully...');
  await clickhouseService.close();
  process.exit(0);
});

// Start server
async function startServer() {
  await initializeDatabase();
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard API available at http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📋 Available tables: http://localhost:${PORT}/api/tables`);
  });
}

startServer().catch(console.error);

module.exports = app;
