const { createClient } = require('@clickhouse/client');

class ClickHouseService {
  constructor() {
    this.client = null;
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  // Initialize connection
  async connect() {
    try {
      this.client = createClient({
        url: process.env.CLICKHOUSE_URL,
        username: process.env.CLICKHOUSE_USER,
        password: process.env.CLICKHOUSE_PASSWORD,
        database: process.env.CLICKHOUSE_DB,
      });

      // Test connection
      await this.client.ping();
      console.log('✅ ClickHouse connection successful');
      return true;
    } catch (error) {
      console.error('❌ ClickHouse connection failed:', error.message);
      throw error;
    }
  }

  // Test connection
  async ping() {
    try {
      const result = await this.client.ping();
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Get available tables
  async getTables() {
    try {
      const cacheKey = 'tables';
      const cached = this.cache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
        return cached.data;
      }

      const query = `
        SELECT 
          name,
          engine,
          total_rows,
          total_bytes
        FROM system.tables 
        WHERE database = '${process.env.CLICKHOUSE_DB}'
        ORDER BY name
      `;

      const result = await this.client.query({
        query: query,
        format: 'JSONEachRow'
      });

      const tables = await result.json();

      // Cache the result
      this.cache.set(cacheKey, {
        data: tables,
        timestamp: Date.now()
      });

      return tables;
    } catch (error) {
      console.error('Error fetching tables:', error);
      throw error;
    }
  }

  // Get table schema
  async getTableSchema(tableName) {
    try {
      const query = `DESCRIBE TABLE ${tableName}`;
      
      const result = await this.client.query({
        query: query,
        format: 'JSONEachRow'
      });

      return await result.json();
    } catch (error) {
      console.error(`Error fetching schema for ${tableName}:`, error);
      throw error;
    }
  }

  // Build WHERE clause from filters
  buildWhereClause(filters = {}, searchTerm = '') {
    const conditions = [];
    
    // Add search condition
    if (searchTerm && searchTerm.trim() !== '') {
      // Search across main text fields for daily_worker_summary
      // Escape single quotes and use case-insensitive search
      const escapedSearch = searchTerm.replace(/'/g, "''");
      const searchCondition = `(
        lower(toString(client_name)) LIKE lower('%${escapedSearch}%') OR
        lower(toString(staff_name)) LIKE lower('%${escapedSearch}%') OR
        toString(work_date) LIKE '%${escapedSearch}%' OR
        lower(toString(ifNull(leave_type, ''))) LIKE lower('%${escapedSearch}%') OR
        toString(ifNull(checkin_lat, '')) LIKE '%${escapedSearch}%' OR
        toString(ifNull(checkin_lng, '')) LIKE '%${escapedSearch}%' OR
        toString(ifNull(checkout_lat, '')) LIKE '%${escapedSearch}%' OR
        toString(ifNull(checkout_lng, '')) LIKE '%${escapedSearch}%'
      )`;
      conditions.push(searchCondition);
    }

    // Add column filters
    Object.entries(filters).forEach(([field, value]) => {
      if (value && value.toString().trim() !== '') {
        // Handle different data types
        if (typeof value === 'number') {
          conditions.push(`${field} = ${value}`);
        } else if (field.toLowerCase().includes('date')) {
          conditions.push(`toDate(${field}) = '${value}'`);
        } else if (field.toLowerCase().includes('time')) {
          conditions.push(`toString(${field}) LIKE '%${value}%'`);
        } else {
          conditions.push(`toString(${field}) ILIKE '%${value}%'`);
        }
      }
    });
    
    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  }

  // Get paginated data with search and filters
  async getTableData({
    tableName,
    page = 1,
    pageSize = 5,
    search = '',
    sortField = '',
    sortDirection = 'ASC',
    filters = {},
    columns = ['*']
  } = {}) {
    try {
      const offset = (page - 1) * pageSize;
      
      // Validate table name to prevent SQL injection
      const tables = await this.getTables();
      const tableExists = tables.some(t => t.name === tableName);
      if (!tableExists) {
        throw new Error(`Table ${tableName} does not exist`);
      }

      // Build column selection
      const columnStr = Array.isArray(columns) ? columns.join(', ') : '*';
      
      // Build base query
      let query = `SELECT ${columnStr} FROM ${tableName}`;

      // Add WHERE clause
      const whereClause = this.buildWhereClause(filters, search);
      if (whereClause) {
        query += ` ${whereClause}`;
      }

      // Add sorting
      if (sortField) {
        query += ` ORDER BY ${sortField} ${sortDirection.toUpperCase()}`;
      }

      // Add pagination
      query += ` LIMIT ${pageSize} OFFSET ${offset}`;

      console.log('Executing query:', query);

      // Execute main query
      const result = await this.client.query({
        query: query,
        format: 'JSONEachRow'
      });

      const data = await result.json();

      // Get total count for pagination
      let countQuery = `SELECT count(*) as total FROM ${tableName}`;
      if (whereClause) {
        countQuery += ` ${whereClause}`;
      }

      const countResult = await this.client.query({
        query: countQuery,
        format: 'JSONEachRow'
      });
      
      const countData = await countResult.json();
      const total = countData[0]?.total || 0;

      return {
        success: true,
        data: data || [],
        pagination: {
          page,
          pageSize,
          total: parseInt(total),
          totalPages: Math.ceil(total / pageSize)
        },
        query: query // For debugging
      };

    } catch (error) {
      console.error(`Error fetching data from ${tableName}:`, error);
      return {
        success: false,
        error: error.message,
        data: [],
        pagination: {
          page,
          pageSize,
          total: 0,
          totalPages: 0
        }
      };
    }
  }

  // Get aggregated data for analytics/charts
  async getAnalytics(tableName) {
    try {
      // Get table schema first to determine numeric columns
      const schema = await this.getTableSchema(tableName);
      const numericColumns = schema
        .filter(col => 
          col.type.includes('Int') || 
          col.type.includes('Float') || 
          col.type.includes('Decimal')
        )
        .map(col => col.name)
        .slice(0, 5); // Limit to first 5 numeric columns

      const analytics = {};

      // Basic row count
      const countQuery = `SELECT count(*) as total_rows FROM ${tableName}`;
      const countResult = await this.client.query({
        query: countQuery,
        format: 'JSONEachRow'
      });
      const countData = await countResult.json();
      analytics.totalRows = countData[0]?.total_rows || 0;

      // Numeric column statistics
      if (numericColumns.length > 0) {
        for (const column of numericColumns) {
          const statsQuery = `
            SELECT 
              min(${column}) as min_val,
              max(${column}) as max_val,
              avg(${column}) as avg_val,
              sum(${column}) as sum_val
            FROM ${tableName}
            WHERE ${column} IS NOT NULL
          `;
          
          try {
            const statsResult = await this.client.query({
              query: statsQuery,
              format: 'JSONEachRow'
            });
            const statsData = await statsResult.json();
            analytics[column] = statsData[0] || {};
          } catch (err) {
            console.warn(`Could not get stats for column ${column}:`, err.message);
          }
        }
      }

      return {
        success: true,
        data: analytics
      };

    } catch (error) {
      console.error(`Error fetching analytics for ${tableName}:`, error);
      return {
        success: false,
        error: error.message,
        data: {}
      };
    }
  }

  // Get distinct values for filter dropdowns
  async getDistinctValues(tableName, column, limit = 100) {
    try {
      const cacheKey = `distinct_${tableName}_${column}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
        return cached.data;
      }

      const query = `
        SELECT DISTINCT toString(${column}) as value
        FROM ${tableName}
        WHERE ${column} IS NOT NULL AND toString(${column}) != ''
        ORDER BY value
        LIMIT ${limit}
      `;

      const result = await this.client.query({
        query: query,
        format: 'JSONEachRow'
      });

      const data = await result.json();
      const values = data.map(row => row.value);

      // Cache the result
      this.cache.set(cacheKey, {
        data: values,
        timestamp: Date.now()
      });

      return {
        success: true,
        data: values
      };
    } catch (error) {
      console.error(`Error fetching distinct values for ${tableName}.${column}:`, error);
      return {
        success: false,
        error: error.message,
        data: []
      };
    }
  }

  // Execute custom query (be careful with this in production)
  async executeCustomQuery(query, format = 'JSONEachRow') {
    try {
      // Basic security check - only allow SELECT statements
      if (!query.trim().toUpperCase().startsWith('SELECT')) {
        throw new Error('Only SELECT queries are allowed');
      }

      const result = await this.client.query({
        query: query,
        format: format
      });

      const data = await result.json();

      return {
        success: true,
        data: data,
        query: query
      };
    } catch (error) {
      console.error('Error executing custom query:', error);
      return {
        success: false,
        error: error.message,
        data: [],
        query: query
      };
    }
  }

  // Close connection
  async close() {
    if (this.client) {
      await this.client.close();
      console.log('ClickHouse connection closed');
    }
  }
}

module.exports = new ClickHouseService();
