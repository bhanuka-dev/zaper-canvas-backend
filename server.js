require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const clickhouseService = require('./services/clickhouse-service');
const llmService = require('./services/llm-service');

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

    // Get total count for pagination
    let countQuery;
    let countResult;

    try {
      // Handle UNION ALL queries differently
      if (query.toUpperCase().includes('UNION ALL')) {
        // For UNION ALL queries, wrap the entire query in a subquery
        let baseQuery = query;
        // Remove ORDER BY and LIMIT from the base query
        baseQuery = baseQuery.replace(/ORDER BY.*?(?=LIMIT|$)/i, '');
        baseQuery = baseQuery.replace(/LIMIT.*$/i, '');

        // Add WHERE conditions to both parts of UNION if needed
        if (conditions.length > 0) {
          const whereClause = conditions.join(' AND ');
          // This is complex for UNION queries, so we'll wrap the whole thing
          baseQuery = `SELECT * FROM (${baseQuery}) WHERE ${whereClause}`;
        }

        countQuery = `SELECT COUNT(*) as total FROM (${baseQuery}) as subquery`;
      } else {
        // Standard single table query
        countQuery = query.replace(/SELECT.*?FROM/i, 'SELECT COUNT(*) as total FROM');
        // Remove ORDER BY, GROUP BY, and LIMIT from count query
        countQuery = countQuery.replace(/ORDER BY.*?(?=LIMIT|GROUP BY|$)/i, '');
        countQuery = countQuery.replace(/GROUP BY.*?(?=LIMIT|$)/i, '');
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
      }

      console.log('Count query:', countQuery);
      countResult = await clickhouseService.executeCustomQuery(countQuery, format);
    } catch (countError) {
      console.warn('Count query failed, using fallback:', countError.message);
      // Fallback: return the actual result count
      countResult = { success: true, data: [{ total: result.data ? result.data.length : 0 }] };
    }
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

// Chat endpoint for LLM-powered query generation
app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      cardType,
      tableName = 'daily_worker_summary'
    } = req.body;

    // Validate required fields
    if (!message || !cardType) {
      return res.status(400).json({
        success: false,
        error: 'Message and cardType are required',
        data: null
      });
    }

    // Validate card type
    const validCardTypes = ['table', 'bar', 'line', 'pie', 'map', 'kpi'];
    if (!validCardTypes.includes(cardType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid cardType. Must be one of: ${validCardTypes.join(', ')}`,
        data: null
      });
    }

    console.log(`Chat request - Card Type: ${cardType}, Message: "${message}"`);

    // Process the user request with LLM
    const result = await llmService.processUserRequest(message, cardType, tableName);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to process chat request',
        data: null,
        query: result.query,
        explanation: result.explanation
      });
    }

    // Return successful result
    res.json({
      success: true,
      data: result.data,
      query: result.query,
      explanation: result.explanation,
      cardType: result.cardType,
      columns: result.columns,
      metadata: result.metadata,
      tableName: tableName
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while processing chat request',
      data: null,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Get available chat schemas
app.get('/api/chat/schemas', (req, res) => {
  try {
    const schemas = llmService.getAvailableSchemas();
    res.json({
      success: true,
      data: schemas
    });
  } catch (error) {
    console.error('Error fetching chat schemas:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {}
    });
  }
});

// Get schema for specific table
app.get('/api/chat/schemas/:tableName', (req, res) => {
  try {
    const { tableName } = req.params;
    const schema = llmService.getTableSchema(tableName);

    if (!schema) {
      return res.status(404).json({
        success: false,
        error: `Table ${tableName} not found`,
        data: null
      });
    }

    res.json({
      success: true,
      data: schema,
      tableName: tableName
    });
  } catch (error) {
    console.error('Error fetching table schema:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: null
    });
  }
});

// Get location data for mapping (optimized endpoint for map visualizations)
app.get('/api/tables/:tableName/locations', async (req, res) => {
  try {
    const { tableName } = req.params;
    const {
      limit = 100,
      type = 'checkin', // 'checkin', 'checkout', or 'both'
      includeMetrics = 'basic' // 'basic', 'earnings', 'hours', 'all'
    } = req.query;

    // Validate table name
    const tables = await clickhouseService.getTables();
    const tableExists = tables.some(t => t.name === tableName);
    if (!tableExists) {
      return res.status(404).json({
        success: false,
        error: `Table ${tableName} does not exist`,
        data: []
      });
    }

    // Build query based on location type
    let locationFields = '';
    let whereClause = '';

    if (type === 'checkin') {
      locationFields = 'checkin_lat as lat, checkin_lng as lng';
      whereClause = 'WHERE checkin_lat IS NOT NULL AND checkin_lng IS NOT NULL';
    } else if (type === 'checkout') {
      locationFields = 'checkout_lat as lat, checkout_lng as lng';
      whereClause = 'WHERE checkout_lat IS NOT NULL AND checkout_lng IS NOT NULL';
    } else if (type === 'both') {
      // Return both check-in and check-out locations
      const checkinQuery = `
        SELECT
          checkin_lat as lat,
          checkin_lng as lng,
          'checkin' as location_type,
          staff_name,
          client_name,
          work_date,
          ${includeMetrics === 'all' || includeMetrics === 'hours' ? 'total_work_hours,' : ''}
          ${includeMetrics === 'all' || includeMetrics === 'earnings' ? 'total_earnings,' : ''}
          checkin_time as timestamp
        FROM ${tableName}
        WHERE checkin_lat IS NOT NULL AND checkin_lng IS NOT NULL
        LIMIT ${Math.floor(limit / 2)}
      `;

      const checkoutQuery = `
        SELECT
          checkout_lat as lat,
          checkout_lng as lng,
          'checkout' as location_type,
          staff_name,
          client_name,
          work_date,
          ${includeMetrics === 'all' || includeMetrics === 'hours' ? 'total_work_hours,' : ''}
          ${includeMetrics === 'all' || includeMetrics === 'earnings' ? 'total_earnings,' : ''}
          checkout_time as timestamp
        FROM ${tableName}
        WHERE checkout_lat IS NOT NULL AND checkout_lng IS NOT NULL
        LIMIT ${Math.floor(limit / 2)}
      `;

      const finalQuery = `${checkinQuery} UNION ALL ${checkoutQuery}`;

      const result = await clickhouseService.executeCustomQuery(finalQuery);
      return res.json(result);
    }

    // Build metrics selection
    let metricsFields = '';
    if (includeMetrics === 'earnings') {
      metricsFields = ', total_earnings, work_amount, overtime_amount';
    } else if (includeMetrics === 'hours') {
      metricsFields = ', total_work_hours, overtime_hours, effective_work_hours';
    } else if (includeMetrics === 'all') {
      metricsFields = ', total_work_hours, overtime_hours, total_earnings, work_amount';
    }

    const query = `
      SELECT
        ${locationFields},
        staff_name,
        client_name,
        work_date
        ${metricsFields}
      FROM ${tableName}
      ${whereClause}
      ORDER BY work_date DESC
      LIMIT ${limit}
    `;

    const result = await clickhouseService.executeCustomQuery(query);
    res.json(result);

  } catch (error) {
    console.error('Error fetching location data:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

// Execute dummy query for card types (empty state)
app.post('/api/query/execute/dummy', async (req, res) => {
  try {
    const {
      cardType,
      page = 1,
      pageSize = 5
    } = req.body;

    // Validate card type
    const validCardTypes = ['table', 'bar', 'line', 'pie', 'map', 'kpi'];
    if (!cardType || !validCardTypes.includes(cardType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid cardType. Must be one of: ${validCardTypes.join(', ')}`,
        data: []
      });
    }

    let dummyData = [];
    let totalCount = 0;
    let dummyQuery = '';

    switch (cardType) {
      case 'table':
        // Countries data for table
        const countriesData = [
          { country: 'United Arab Emirates', capital: 'Abu Dhabi', currency: 'AED', population: 9890400, continent: 'Asia' },
          { country: 'United States', capital: 'Washington D.C.', currency: 'USD', population: 331900000, continent: 'North America' },
          { country: 'United Kingdom', capital: 'London', currency: 'GBP', population: 67330000, continent: 'Europe' },
          { country: 'India', capital: 'New Delhi', currency: 'INR', population: 1380000000, continent: 'Asia' },
          { country: 'Germany', capital: 'Berlin', currency: 'EUR', population: 83240000, continent: 'Europe' },
          { country: 'Japan', capital: 'Tokyo', currency: 'JPY', population: 125360000, continent: 'Asia' },
          { country: 'Australia', capital: 'Canberra', currency: 'AUD', population: 25690000, continent: 'Oceania' },
          { country: 'Canada', capital: 'Ottawa', currency: 'CAD', population: 38230000, continent: 'North America' },
          { country: 'France', capital: 'Paris', currency: 'EUR', population: 67750000, continent: 'Europe' },
          { country: 'Brazil', capital: 'Brasília', currency: 'BRL', population: 215300000, continent: 'South America' }
        ];

        totalCount = countriesData.length;
        const startIndex = (page - 1) * pageSize;
        dummyData = countriesData.slice(startIndex, startIndex + pageSize);
        dummyQuery = 'SELECT country, capital, currency, population, continent FROM world_countries ORDER BY population DESC';
        break;

      case 'bar':
      case 'line':
        // Chart data - monthly sales
        dummyData = [
          { month: 'January', sales: 45000 },
          { month: 'February', sales: 52000 },
          { month: 'March', sales: 48000 },
          { month: 'April', sales: 61000 },
          { month: 'May', sales: 55000 },
          { month: 'June', sales: 67000 },
          { month: 'July', sales: 71000 },
          { month: 'August', sales: 64000 },
          { month: 'September', sales: 59000 },
          { month: 'October', sales: 73000 },
          { month: 'November', sales: 79000 },
          { month: 'December', sales: 85000 }
        ];
        totalCount = dummyData.length;
        dummyQuery = 'SELECT month, SUM(sales) FROM monthly_sales GROUP BY month ORDER BY month';
        break;

      case 'pie':
        // Pie chart data - market share
        dummyData = [
          { category: 'Mobile Apps', percentage: 35 },
          { category: 'Web Development', percentage: 28 },
          { category: 'Cloud Services', percentage: 22 },
          { category: 'AI/ML Solutions', percentage: 10 },
          { category: 'IoT Projects', percentage: 5 }
        ];
        totalCount = dummyData.length;
        dummyQuery = 'SELECT category, percentage FROM market_share ORDER BY percentage DESC';
        break;

      case 'map':
        // Dubai landmarks for map
        dummyData = [
          {
            lat: 25.1972,
            lng: 55.2744,
            name: 'Burj Khalifa',
            type: 'landmark',
            description: 'World\'s tallest building',
            visitors: 15000
          },
          {
            lat: 25.2048,
            lng: 55.2708,
            name: 'Dubai Mall',
            type: 'shopping',
            description: 'World\'s largest shopping mall',
            visitors: 80000
          },
          {
            lat: 25.2138,
            lng: 55.2621,
            name: 'Dubai Fountain',
            type: 'attraction',
            description: 'World\'s largest choreographed fountain',
            visitors: 25000
          },
          {
            lat: 25.1984,
            lng: 55.2731,
            name: 'Dubai Opera',
            type: 'entertainment',
            description: 'Multi-format performing arts theatre',
            visitors: 3500
          },
          {
            lat: 25.2084,
            lng: 55.2719,
            name: 'Souk Al Bahar',
            type: 'shopping',
            description: 'Traditional Arabian marketplace',
            visitors: 12000
          },
          {
            lat: 25.1946,
            lng: 55.2727,
            name: 'Address Downtown',
            type: 'hotel',
            description: 'Luxury hotel with fountain views',
            visitors: 2500
          }
        ];
        totalCount = dummyData.length;
        dummyQuery = 'SELECT lat, lng, name, type, description, visitors FROM dubai_landmarks WHERE type IS NOT NULL';
        break;

      case 'kpi':
        // KPI metrics
        dummyData = [
          {
            metric: 'Total Revenue',
            value: 2847500,
            unit: 'AED',
            change: 12.5,
            period: 'This Month'
          },
          {
            metric: 'Active Users',
            value: 48392,
            unit: 'users',
            change: 8.7,
            period: 'Last 30 Days'
          },
          {
            metric: 'Conversion Rate',
            value: 24.8,
            unit: '%',
            change: -2.1,
            period: 'This Quarter'
          },
          {
            metric: 'Customer Satisfaction',
            value: 4.6,
            unit: '/5',
            change: 0.3,
            period: 'Average Rating'
          }
        ];
        totalCount = dummyData.length;
        dummyQuery = 'SELECT metric, value, unit, change, period FROM kpi_metrics';
        break;
    }

    // Calculate pagination
    const totalPages = Math.ceil(totalCount / pageSize);

    res.json({
      success: true,
      data: dummyData,
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        total: totalCount,
        totalPages: totalPages
      },
      query: dummyQuery,
      cardType: cardType,
      isDummy: true,
      message: `Sample ${cardType} data for demonstration purposes`
    });

  } catch (error) {
    console.error('Error generating dummy data:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while generating dummy data',
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

// Get available columns for query validation
app.get('/api/tables/:tableName/columns', async (req, res) => {
  try {
    const { tableName } = req.params;

    // Get table schema
    const schema = await clickhouseService.getTableSchema(tableName);

    if (!schema || schema.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Table ${tableName} not found or has no columns`,
        data: []
      });
    }

    // Format column information for frontend use
    const columns = schema.map(col => ({
      name: col.name,
      type: col.type,
      description: col.comment || `${col.name} field`,
      nullable: col.type.includes('Nullable'),
      isNumeric: col.type.includes('Int') || col.type.includes('Float') || col.type.includes('Decimal'),
      isDate: col.type.includes('Date') || col.type.includes('DateTime'),
      isString: col.type.includes('String'),
      isLocation: col.name.includes('lat') || col.name.includes('lng')
    }));

    res.json({
      success: true,
      tableName: tableName,
      totalColumns: columns.length,
      data: columns
    });

  } catch (error) {
    console.error('Error fetching columns:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
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
