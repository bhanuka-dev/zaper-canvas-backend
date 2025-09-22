const { Agent, run, tool } = require('@openai/agents');
const { z } = require('zod');
const clickhouseService = require('./clickhouse-service');

class LLMService {
  constructor() {
    this.tableSchema = {
      'daily_worker_summary': {
        name: 'daily_worker_summary',
        description: 'Daily worker summary containing workforce analytics data',
        columns: [
          { name: 'id', type: 'UInt64', description: 'Unique record ID' },
          { name: 'client_id', type: 'UInt32', description: 'Client ID - optimized for compression' },
          { name: 'staff_id', type: 'UInt32', description: 'Staff ID - optimized for compression' },
          { name: 'client_name', type: 'LowCardinality(String)', description: 'Client name with dictionary encoding' },
          { name: 'staff_name', type: 'LowCardinality(String)', description: 'Staff name with dictionary encoding' },
          { name: 'work_date', type: 'Date', description: 'Work date - primary time dimension' },
          { name: 'checkin_time', type: 'Nullable(DateTime)', description: 'Check-in timestamp' },
          { name: 'checkout_time', type: 'Nullable(DateTime)', description: 'Check-out timestamp' },
          { name: 'checkin_lat', type: 'Nullable(Float64)', description: 'Check-in latitude coordinate' },
          { name: 'checkin_lng', type: 'Nullable(Float64)', description: 'Check-in longitude coordinate' },
          { name: 'checkout_lat', type: 'Nullable(Float64)', description: 'Check-out latitude coordinate' },
          { name: 'checkout_lng', type: 'Nullable(Float64)', description: 'Check-out longitude coordinate' },
          { name: 'total_work_hours', type: 'Decimal(9, 2)', description: 'Total work hours with 2 decimal precision' },
          { name: 'total_break_hours', type: 'Decimal(9, 2)', description: 'Total break hours' },
          { name: 'overtime_hours', type: 'Decimal(9, 2)', description: 'Overtime hours' },
          { name: 'work_amount', type: 'Decimal(18, 2)', description: 'Daily work earnings' },
          { name: 'overtime_amount', type: 'Decimal(18, 2)', description: 'Overtime earnings' },
          { name: 'fine_amount', type: 'Decimal(18, 2)', description: 'Fine amount if any' },
          { name: 'weekday', type: 'UInt8', description: 'Day of week (1=Monday, 7=Sunday)' },
          { name: 'leave_type', type: 'LowCardinality(Nullable(String))', description: 'Leave type if absent' },
          { name: 'work_month', type: 'UInt16', description: 'Year-month for monthly aggregations (YYYYMM format)' },
          { name: 'work_year', type: 'UInt16', description: 'Year for yearly aggregations' },
          { name: 'work_quarter', type: 'UInt8', description: 'Quarter for quarterly analysis (1-4)' },
          { name: 'is_present', type: 'UInt8', description: 'Attendance flag (1=present, 0=absent)' },
          { name: 'has_overtime', type: 'UInt8', description: 'Overtime flag (1=has overtime, 0=no overtime)' },
          { name: 'has_fine', type: 'UInt8', description: 'Fine flag (1=has fine, 0=no fine)' },
          { name: 'effective_work_hours', type: 'Decimal(9, 2)', description: 'Net productive hours (total_work_hours - total_break_hours)' },
          { name: 'total_earnings', type: 'Decimal(18, 2)', description: 'Net daily earnings (work_amount + overtime_amount - fine_amount)' },
          { name: 'attendance_score', type: 'Float32', description: 'Attendance performance score' },
          { name: 'created_at', type: 'DateTime', description: 'Record creation timestamp' }
        ]
      }
    };

    // Initialize the query generation agent
    this.queryAgent = new Agent({
      name: 'ClickHouse Query Generator',
      instructions: this.getAgentInstructions(),
      tools: [this.createQueryGeneratorTool()]
    });
  }

  getAgentInstructions() {
    return `You are a ClickHouse SQL query generator for workforce analytics dashboards. Your job is to convert natural language requests into optimized ClickHouse SQL queries.

CRITICAL RULES:
1. ONLY generate SELECT statements - no other SQL commands
2. ALWAYS use the table name "daily_worker_summary"
3. Return ONLY the SQL query without any markdown formatting, explanations, or additional text
4. Generate queries appropriate for the specified card type
5. Use proper ClickHouse functions and syntax
6. Handle date formatting properly (work_date is Date type)
7. Use appropriate aggregations for the card type
8. Consider performance - use appropriate LIMIT clauses
9. Handle NULL values properly
10. Do NOT wrap queries in markdown code blocks
11. NEVER use column aliases with AS - always use original database column names
12. Keep all field names exactly as they appear in the database schema

CARD TYPE GUIDELINES:

TABLE CARD:
- Select relevant columns for tabular display
- Use proper ordering
- Include pagination-friendly structure
- Limit to reasonable row count (50-100 rows)

BAR/LINE/PIE CHART:
- Must include exactly 2 columns: one for labels/categories, one for values
- Use GROUP BY for aggregations
- Choose meaningful time periods or categories
- Order by value or time appropriately
- Limit to 10-20 data points for readability

MAP CARD:
- ALWAYS include latitude and longitude coordinates (checkin_lat, checkin_lng, checkout_lat, checkout_lng)
- Return data in format suitable for mapping: coordinates + relevant metrics
- Use checkin coordinates for check-in locations, checkout coordinates for check-out locations
- Include staff_name, client_name for map markers/popups
- Group by coordinates when aggregating multiple records at same location
- Handle NULL coordinates gracefully with WHERE clauses
- NEVER rename coordinate columns - use checkin_lat, checkin_lng, checkout_lat, checkout_lng as-is

KPI CARD:
- Return single aggregate values
- Use functions like COUNT(), SUM(), AVG(), MAX(), MIN()
- Return multiple related KPIs in one query if relevant
- Use meaningful aliases for the metrics

COMMON PATTERNS:
- For time-based queries: GROUP BY work_date, work_month, work_year, work_quarter
- For staff analysis: GROUP BY staff_name, staff_id
- For client analysis: GROUP BY client_name, client_id
- For attendance: Use is_present, leave_type
- For earnings: Use total_earnings, work_amount, overtime_amount
- For time analysis: Use total_work_hours, overtime_hours, effective_work_hours

EXAMPLE QUERIES:
- "Show total hours by staff" → SELECT staff_name, SUM(total_work_hours) FROM daily_worker_summary GROUP BY staff_name ORDER BY SUM(total_work_hours) DESC LIMIT 20
- "Monthly earnings trend" → SELECT work_month, SUM(total_earnings) FROM daily_worker_summary GROUP BY work_month ORDER BY work_month LIMIT 12
- "Attendance rate KPI" → SELECT AVG(is_present) * 100 FROM daily_worker_summary
- "Check-in locations map" → SELECT checkin_lat, checkin_lng, staff_name, client_name, total_work_hours FROM daily_worker_summary WHERE checkin_lat IS NOT NULL AND checkin_lng IS NOT NULL LIMIT 100
- "Work sites by earnings" → SELECT checkin_lat, checkin_lng, SUM(total_earnings) FROM daily_worker_summary WHERE checkin_lat IS NOT NULL GROUP BY checkin_lat, checkin_lng ORDER BY SUM(total_earnings) DESC LIMIT 50`;
  }

  createQueryGeneratorTool() {
    return tool({
      name: 'generate_clickhouse_query',
      description: 'Generate a ClickHouse SQL query based on user request and card type',
      parameters: z.object({
        query: z.string().describe('The generated ClickHouse SQL query'),
        explanation: z.string().describe('Brief explanation of what the query does'),
        cardType: z.enum(['table', 'bar', 'line', 'pie', 'map', 'kpi']).describe('The card type this query is optimized for'),
        columns: z.array(z.string()).describe('List of column names returned by the query')
      }),
      execute: async (input) => {
        // Validate that it's a SELECT query
        if (!input.query.trim().toUpperCase().startsWith('SELECT')) {
          throw new Error('Only SELECT queries are allowed');
        }

        // Validate that it uses the correct table
        if (!input.query.toLowerCase().includes('daily_worker_summary')) {
          throw new Error('Query must use the daily_worker_summary table');
        }

        return {
          query: input.query,
          explanation: input.explanation,
          cardType: input.cardType,
          columns: input.columns,
          validated: true
        };
      }
    });
  }

  async generateQuery(userMessage, cardType, tableName = 'daily_worker_summary') {
    try {
      // Validate inputs
      if (!userMessage || !cardType) {
        throw new Error('User message and card type are required');
      }

      const validCardTypes = ['table', 'bar', 'line', 'pie', 'map', 'kpi'];
      if (!validCardTypes.includes(cardType)) {
        throw new Error(`Invalid card type. Must be one of: ${validCardTypes.join(', ')}`);
      }

      // Get table schema information
      const tableInfo = this.tableSchema[tableName];
      if (!tableInfo) {
        throw new Error(`Table ${tableName} not found in schema`);
      }

      // Create the prompt with context
      const prompt = `
USER REQUEST: "${userMessage}"
CARD TYPE: ${cardType}

Generate a ClickHouse SQL query that:
1. Answers the user's request for a ${cardType} visualization
2. Uses ONLY the daily_worker_summary table
3. Returns clean SQL without markdown or explanations
4. Is optimized for ${cardType} display
5. NEVER uses column aliases (AS) - use original column names only

TABLE: ${tableInfo.name}
COLUMNS: ${tableInfo.columns.map(col => `${col.name} (${col.type})`).join(', ')}

IMPORTANT: Use exact column names from the schema. Do NOT rename columns with AS aliases.
Examples:
- Use "checkin_lat" NOT "checkin_lat AS lat"
- Use "SUM(total_work_hours)" NOT "SUM(total_work_hours) AS total_hours"

Generate ONLY the SQL query using the generate_clickhouse_query tool.`;

      // Run the agent
      const result = await run(this.queryAgent, prompt);

      // Extract the tool result
      if (result.messages && result.messages.length > 0) {
        for (const message of result.messages) {
          if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
              if (toolCall.function && toolCall.function.name === 'generate_clickhouse_query') {
                const toolResult = JSON.parse(toolCall.function.arguments);
                return {
                  success: true,
                  query: toolResult.query,
                  explanation: toolResult.explanation,
                  cardType: toolResult.cardType,
                  columns: toolResult.columns,
                  tableName: tableName
                };
              }
            }
          }
        }
      }

      // Fallback - parse SQL from final output if tool calls not found
      let extractedQuery = result.finalOutput || 'SELECT * FROM daily_worker_summary LIMIT 10';

      // Extract SQL from markdown code blocks (more flexible pattern)
      const sqlMatch = extractedQuery.match(/```(?:sql)?\s*\n?([\s\S]*?)\n?```/);
      if (sqlMatch) {
        extractedQuery = sqlMatch[1].trim();
      } else {
        // Try to find SELECT statement in the text (more comprehensive)
        const selectMatch = extractedQuery.match(/SELECT[\s\S]*?(?=\n\n|$|Explanation|;)/i);
        if (selectMatch) {
          extractedQuery = selectMatch[0].trim();
        }
      }

      // Clean up the query
      extractedQuery = extractedQuery
        .replace(/;+$/, '') // Remove trailing semicolons
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();

      return {
        success: true,
        query: extractedQuery,
        explanation: 'Generated query from LLM response',
        cardType: cardType,
        columns: ['*'],
        tableName: tableName
      };

    } catch (error) {
      console.error('Error generating query:', error);
      return {
        success: false,
        error: error.message,
        query: null,
        explanation: null,
        cardType: cardType,
        columns: [],
        tableName: tableName
      };
    }
  }

  async executeGeneratedQuery(queryResult) {
    try {
      if (!queryResult.success || !queryResult.query) {
        throw new Error('Invalid query result provided');
      }

      // Execute the query using the ClickHouse service
      const result = await clickhouseService.executeCustomQuery(queryResult.query);

      return {
        success: result.success,
        data: result.data,
        error: result.error,
        query: queryResult.query,
        explanation: queryResult.explanation,
        cardType: queryResult.cardType,
        columns: queryResult.columns,
        metadata: {
          rowCount: result.data ? result.data.length : 0,
          generatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error executing generated query:', error);
      return {
        success: false,
        error: error.message,
        data: [],
        query: queryResult.query,
        explanation: queryResult.explanation,
        cardType: queryResult.cardType,
        columns: queryResult.columns
      };
    }
  }

  // Convenience method to generate and execute in one call
  async processUserRequest(userMessage, cardType, tableName = 'daily_worker_summary') {
    try {
      // Generate the query
      const queryResult = await this.generateQuery(userMessage, cardType, tableName);

      if (!queryResult.success) {
        return queryResult;
      }

      // Execute the query
      const executionResult = await this.executeGeneratedQuery(queryResult);

      return executionResult;
    } catch (error) {
      console.error('Error processing user request:', error);
      return {
        success: false,
        error: error.message,
        data: [],
        query: null,
        explanation: null,
        cardType: cardType,
        columns: []
      };
    }
  }

  // Get available tables and their schemas
  getAvailableSchemas() {
    return this.tableSchema;
  }

  // Get schema for specific table
  getTableSchema(tableName) {
    return this.tableSchema[tableName] || null;
  }
}

module.exports = new LLMService();