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
          { name: 'checkin_project_id', type: 'Nullable(Int32)', description: 'Check-in project ID (NULL or -1 = outside project location)' },
          { name: 'checkout_project_id', type: 'Nullable(Int32)', description: 'Check-out project ID (NULL or -1 = outside project location)' },
          { name: 'total_work_hours', type: 'Decimal(9, 2)', description: 'Total work hours with 2 decimal precision' },
          { name: 'total_break_hours', type: 'Decimal(9, 2)', description: 'Total break hours' },
          { name: 'overtime_hours', type: 'Decimal(9, 2)', description: 'Overtime hours' },
          { name: 'leave_type', type: 'LowCardinality(Nullable(String))', description: 'Leave type if absent (NULL=present/no record, comp_off, off_day, sick_leave, unpaid_leave)' },
          { name: 'is_present', type: 'UInt8', description: 'Attendance flag (1=present, 0=absent)' },
          { name: 'has_overtime', type: 'UInt8', description: 'Overtime flag (1=has overtime, 0=no overtime)' },
          { name: 'effective_work_hours', type: 'Decimal(9, 2)', description: 'Net productive hours (total_work_hours - total_break_hours)' },
          { name: 'attendance_score', type: 'Float32', description: 'Attendance performance score' },
          { name: 'created_at', type: 'DateTime', description: 'Record creation timestamp' }
        ]
      },
      'client_projects': {
        name: 'client_projects',
        description: 'Client projects with location and metadata information',
        columns: [
          { name: 'project_id', type: 'UInt32', description: 'Unique project identifier' },
          { name: 'client_id', type: 'UInt32', description: 'Client ID that owns this project' },
          { name: 'project_name', type: 'LowCardinality(String)', description: 'Short project name for display' },
          { name: 'project_code', type: 'LowCardinality(Nullable(String))', description: 'Project code/abbreviation for reference' },
          { name: 'project_full_name', type: 'String', description: 'Complete project name with full details' },
          { name: 'latitude', type: 'Nullable(Float64)', description: 'Project location latitude coordinate' },
          { name: 'longitude', type: 'Nullable(Float64)', description: 'Project location longitude coordinate' },
          { name: 'is_active', type: 'UInt8', description: 'Project active status (1=active, 0=inactive)' },
          { name: 'created_at', type: 'DateTime', description: 'Record creation timestamp' },
          { name: 'updated_at', type: 'DateTime', description: 'Last update timestamp' },
          { name: 'has_location', type: 'UInt8', description: 'Whether project has GPS coordinates (1=has location, 0=no location)' },
          { name: 'location_string', type: 'String', description: 'Formatted location string for display' }
        ]
      }
    };

    // Initialize the query generation agent
    this.queryAgent = new Agent({
      name: 'ClickHouse Query Generator',
      instructions: this.getAgentInstructions(),
      tools: [this.createQueryGeneratorTool()]
    });

    // Initialize the query correction agent for handling ClickHouse errors
    this.correctionAgent = new Agent({
      name: 'ClickHouse Query Error Corrector',
      instructions: this.getCorrectionAgentInstructions(),
      tools: [this.createQueryCorrectorTool()]
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
11. NEVER use column aliases with AS for table/bar/line/pie/map cards - use original database column names
12. FOR KPI CARDS ONLY: Use AS aliases to provide meaningful display names (e.g., "COUNT(*) AS staff_count")
13. Keep all field names exactly as they appear in the database schema
14. ONLY use columns that exist in the provided schema - never invent or assume columns
15. If asked about non-existent fields, use the closest matching existing column
16. NEVER use implicit column aliases (like COUNT(*) days_present) - use explicit AS or no alias
17. CRITICAL: Each SELECT item must be properly separated by commas with NO extra text

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
- Return SINGLE aggregate value (one row, one column)
- NEVER use GROUP BY in main query (it creates multiple rows)
- For counting staff with conditions, use subqueries: COUNT(*) FROM (SELECT staff_id ... GROUP BY staff_id HAVING ...)
- Use functions like COUNT(), SUM(), AVG(), MAX(), MIN()
- MUST use human-readable column aliases with AS keyword for KPI display
- Column name becomes the KPI title, value becomes the KPI value
- Use natural language titles that end users can understand
- Examples: "COUNT(*) AS Staff with Poor Attendance", "AVG(attendance_score) AS Average Attendance Rate"
- For "unpaid regularly" queries: use subquery pattern for single result

COMMON PATTERNS:
- For daily queries: GROUP BY work_date
- For monthly queries: GROUP BY toYYYYMM(work_date)
- For yearly queries: GROUP BY toYear(work_date)
- For quarterly queries: GROUP BY toQuarter(work_date)
- For weekday analysis: GROUP BY toDayOfWeek(work_date)
- For staff analysis: GROUP BY staff_name, staff_id
- For client analysis: GROUP BY client_name, client_id
- For attendance: Use is_present, leave_type
- For time analysis: Use total_work_hours, overtime_hours, effective_work_hours
- For project location tracking: Use checkin_project_id, checkout_project_id (NULL or -1 = outside project)
- For project analysis: JOIN with client_projects table on project_id
- For location-based queries: Use latitude/longitude from both tables

DATETIME HANDLING (CRITICAL):
- NEVER use AVG() directly on DateTime columns like checkin_time, checkout_time
- For average check-in hour: AVG(toHour(checkin_time))
- For earliest time: MIN(checkin_time)
- For latest time: MAX(checkout_time)
- For time differences: dateDiff('minute', checkin_time, checkout_time)
- For time formatting: formatDateTime(checkin_time, '%H:%M')
- NEVER use column name 'DAY' - it does not exist! Use work_date instead

DATE-BASED FILTERING (CRITICAL - EXACT SYNTAX):
- For "this week": WHERE work_date >= toMonday(today()) AND work_date < addDays(toMonday(today()), 7)
- For "this month": WHERE toYYYYMM(work_date) = toYYYYMM(today())
- For "last month": WHERE toYYYYMM(work_date) = toYYYYMM(addMonths(today(), -1))
- For "this year": WHERE toYear(work_date) = toYear(today())
- For "last year": WHERE toYear(work_date) = toYear(today()) - 1
- For "recent 7 days": WHERE work_date >= today() - 7
- For "this quarter": WHERE toQuarter(work_date) = toQuarter(today()) AND toYear(work_date) = toYear(today())
- For "yesterday": WHERE work_date = yesterday()
- For "today": WHERE work_date = today()

CRITICAL LIMITATIONS - NO FINANCIAL DATA:
- NO earnings, payment, salary, wage, or financial data exists in this schema
- NO payment history, financial records, or compensation data
- This is ONLY workforce attendance and time tracking data

HANDLING "PAID/UNPAID" QUERIES:
- If user asks about "unpaid" in workforce context, interpret as attendance issues:
  * "unpaid staff" = staff with low work hours or poor attendance
  * "people who have gone unpaid" = people not working regularly
  * Use is_present, total_work_hours, attendance_score columns
- Never generate queries with financial columns (Payment, Salary, Wage, Pay, Earnings, Cost, Price, Amount)
- For actual payment queries (salary, wage), explain financial data is not available

EXAMPLE QUERIES:
- "Show total hours by staff" → SELECT staff_name, SUM(total_work_hours) FROM daily_worker_summary GROUP BY staff_name ORDER BY SUM(total_work_hours) DESC LIMIT 20
- "Monthly work hours trend" → SELECT toYYYYMM(work_date), SUM(total_work_hours) FROM daily_worker_summary GROUP BY toYYYYMM(work_date) ORDER BY toYYYYMM(work_date) DESC LIMIT 12
- "Last month staff count" → SELECT COUNT(DISTINCT staff_id) FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(addMonths(today(), -1))
- "Current month data" → SELECT COUNT(*) FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(today())
- "How many staff worked last month" → SELECT COUNT(DISTINCT staff_id) FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(addMonths(today(), -1))
- "Staff count this month" → SELECT COUNT(DISTINCT staff_id) FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(today())
- "Attendance rate KPI" → SELECT AVG(is_present) * 100 FROM daily_worker_summary
- "Top 10 staff by check-in times" → SELECT staff_name, AVG(toHour(checkin_time)) FROM daily_worker_summary WHERE checkin_time IS NOT NULL GROUP BY staff_name ORDER BY AVG(toHour(checkin_time)) ASC LIMIT 10
- "Earliest check-in times" → SELECT staff_name, MIN(checkin_time) FROM daily_worker_summary WHERE checkin_time IS NOT NULL GROUP BY staff_name ORDER BY MIN(checkin_time) ASC LIMIT 10
- "Check-in locations map" → SELECT checkin_lat, checkin_lng, staff_name, client_name, total_work_hours FROM daily_worker_summary WHERE checkin_lat IS NOT NULL AND checkin_lng IS NOT NULL LIMIT 100
- "Work sites by hours" → SELECT checkin_lat, checkin_lng, SUM(total_work_hours) FROM daily_worker_summary WHERE checkin_lat IS NOT NULL GROUP BY checkin_lat, checkin_lng ORDER BY SUM(total_work_hours) DESC LIMIT 50
- "People present at projects" → SELECT COUNT(*) FROM daily_worker_summary WHERE checkin_project_id IS NOT NULL AND checkin_project_id != -1 AND is_present = 1
- "People outside project locations" → SELECT COUNT(*) FROM daily_worker_summary WHERE (checkin_project_id IS NULL OR checkin_project_id = -1) AND is_present = 1
- "Staff working outside projects" → SELECT staff_name, COUNT(*) FROM daily_worker_summary WHERE (checkin_project_id IS NULL OR checkin_project_id = -1) GROUP BY staff_name ORDER BY COUNT(*) DESC
- "Project attendance with names" → SELECT p.project_name, COUNT(d.staff_id) FROM daily_worker_summary d JOIN client_projects p ON d.checkin_project_id = p.project_id WHERE d.is_present = 1 GROUP BY p.project_name ORDER BY COUNT(d.staff_id) DESC
- "Show this week's check-ins outside projects" → SELECT staff_name, client_name, checkin_lat, checkin_lng, work_date FROM daily_worker_summary WHERE work_date >= toMonday(today()) AND work_date < addDays(toMonday(today()), 7) AND (checkin_project_id IS NULL OR checkin_project_id = -1) AND checkin_time IS NOT NULL ORDER BY work_date DESC
- "Get people who present this week" → SELECT DISTINCT staff_name FROM daily_worker_summary WHERE work_date >= toMonday(today()) AND work_date < addDays(toMonday(today()), 7) AND is_present = 1 ORDER BY staff_name
- "Last week top 10 staff performance" → SELECT staff_name, SUM(total_work_hours), SUM(effective_work_hours), COUNT(*), AVG(attendance_score) FROM daily_worker_summary WHERE work_date >= subtractDays(toMonday(today()), 7) AND work_date < toMonday(today()) GROUP BY staff_name ORDER BY SUM(effective_work_hours) DESC LIMIT 10
- "People who have gone unpaid regularly" (TABLE) → SELECT staff_name, COUNT(*), SUM(total_work_hours), AVG(attendance_score) FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(addMonths(today(), -1)) AND (is_present = 0 OR total_work_hours < 4) GROUP BY staff_name HAVING COUNT(*) >= 5 ORDER BY COUNT(*) DESC
- "People who have gone unpaid regularly" (KPI) → SELECT COUNT(*) AS "People Needing Attention" FROM (SELECT staff_id FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(addMonths(today(), -1)) AND (is_present = 0 OR total_work_hours < 4) GROUP BY staff_id HAVING COUNT(*) >= 5)
- "Staff with poor attendance last month" (KPI) → SELECT COUNT(*) AS "Staff with Poor Attendance" FROM (SELECT staff_id FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(addMonths(today(), -1)) AND is_present = 0 GROUP BY staff_id HAVING COUNT(*) >= 3)
- "Average attendance rate" (KPI) → SELECT AVG(attendance_score) AS "Average Attendance Rate" FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(today())
- "Total work hours this month" (KPI) → SELECT SUM(total_work_hours) AS "Total Work Hours This Month" FROM daily_worker_summary WHERE toYYYYMM(work_date) = toYYYYMM(today())
- "How many staff worked today" (KPI) → SELECT COUNT(DISTINCT staff_id) AS "Staff Working Today" FROM daily_worker_summary WHERE work_date = today()`;
  }

  getCorrectionAgentInstructions() {
    return `You are a ClickHouse SQL query error corrector for workforce analytics. Your job is to analyze ClickHouse database errors and correct queries based on real error messages.

CORRECTION APPROACH:
1. Analyze the original user intent and the generated query
2. Examine the specific ClickHouse error message to understand what went wrong
3. Apply targeted fixes based on the actual error, not pre-assumptions
4. Focus on translating ClickHouse errors into proper fixes

AVAILABLE SCHEMA:
- daily_worker_summary: ${Object.values(this.tableSchema.daily_worker_summary.columns).map(col => col.name).join(', ')}
- client_projects: ${Object.values(this.tableSchema.client_projects.columns).map(col => col.name).join(', ')}

COMMON ERROR PATTERNS & FIXES:

COLUMN NOT FOUND ERRORS:
- Error: "Unknown identifier 'WEEK'" → Fix: Use "toWeek(work_date)"
- Error: "Unknown identifier 'DAY'" → Fix: Use "toDayOfWeek(work_date)" or "work_date"
- Error: "Unknown identifier 'Payment'" → Fix: Explain financial data not available

SYNTAX ERRORS:
- Error: "Syntax error near 'GROUP BY'" → Fix: Check GROUP BY placement and columns
- Error: "Expected one of: SELECT" → Fix: Ensure proper SQL structure

FUNCTION ERRORS:
- Error: "Wrong number of arguments" → Fix: Check function parameter count
- Error: "Cannot convert DateTime to Float64" → Fix: Use proper type conversion

TYPE MISMATCH ERRORS:
- Error: "Cannot convert types" → Fix: Add proper type casting with CAST() or to*() functions

JOIN ERRORS:
- Error: "Missing JOIN condition" → Fix: Add proper ON clause
- Error: "Ambiguous column reference" → Fix: Add table aliases/prefixes

AGGREGATION ERRORS:
- Error: "Column must appear in GROUP BY" → Fix: Either add to GROUP BY or remove from SELECT
- Error: "Aggregate function in non-aggregate query" → Fix: Add GROUP BY or remove aggregation

ERROR CATEGORIZATION:
1. FIXABLE: Column name issues, syntax problems, type mismatches → Provide corrected query
2. UNFIXABLE: Financial data requests, missing tables → Explain limitation
3. UNCLEAR: Complex errors → Ask for clarification or suggest alternatives

CORRECTION PRINCIPLES:
- Use the exact ClickHouse error message to guide fixes
- Maintain the original user intent as much as possible
- Prefer simple fixes over complex restructuring
- When multiple fixes possible, choose the most straightforward
- If unfixable, explain why and suggest alternatives

Your response should focus on the specific error encountered, not generic validation.`;
  }

  createQueryCorrectorTool() {
    return tool({
      name: 'correct_clickhouse_query',
      description: 'Correct a ClickHouse SQL query based on specific database error message',
      parameters: z.object({
        canCorrect: z.boolean().describe('Whether the error can be corrected'),
        correctedQuery: z.string().nullable().describe('The corrected SQL query (null if cannot be corrected)'),
        errorType: z.enum(['column_not_found', 'syntax_error', 'type_mismatch', 'join_error', 'aggregation_error', 'function_error', 'unfixable', 'other']).describe('Category of the error'),
        explanation: z.string().describe('Explanation of what caused the error and how it was fixed'),
        userFriendlyMessage: z.string().describe('User-friendly explanation of what went wrong'),
        suggestedAlternatives: z.array(z.string()).nullable().describe('Alternative approaches if the query cannot be corrected')
      }),
      execute: async (input) => {
        return {
          canCorrect: input.canCorrect,
          correctedQuery: input.correctedQuery,
          errorType: input.errorType,
          explanation: input.explanation,
          userFriendlyMessage: input.userFriendlyMessage,
          suggestedAlternatives: input.suggestedAlternatives || null
        };
      }
    });
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
        // Check for actual financial columns in the query (not just mentions in explanation)
        const financialColumns = ['payment', 'salary', 'wage', 'earnings', 'cost', 'price', 'amount', 'compensation'];
        const hasFinancialColumns = financialColumns.some(term =>
          input.query.toLowerCase().includes(term)
        );

        if (hasFinancialColumns) {
          throw new Error('Financial columns are not available in this workforce tracking system. This schema only contains attendance, work hours, and location data.');
        }

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

  // Intelligent financial request detection
  isGenuineFinancialRequest(userMessage) {
    const message = userMessage.toLowerCase();

    // Clear financial terms that indicate actual financial data requests
    const clearFinancialTerms = ['salary', 'salaries', 'wage', 'wages', 'payment', 'payments', 'compensation', 'money', 'dollar', 'cost', 'price', 'earnings', 'finance', 'financial'];

    // Attendance-related context keywords that suggest workforce tracking queries
    const attendanceContexts = ['absent', 'attendance', 'present', 'working', 'work', 'staff', 'employee', 'people', 'regularly', 'missing', 'show up', 'came to work', 'not working', 'not present'];

    // Check for clear financial terms
    const hasFinancialTerms = clearFinancialTerms.some(term => message.includes(term));

    // Special handling for "paid/unpaid" - could be attendance-related
    const hasPaidTerms = message.includes('paid') || message.includes('unpaid');
    const hasAttendanceContext = attendanceContexts.some(context => message.includes(context));

    // If it has clear financial terms (not paid/unpaid), block it
    if (hasFinancialTerms) {
      return true;
    }

    // If it mentions paid/unpaid but has attendance context, allow it
    if (hasPaidTerms && hasAttendanceContext) {
      return false; // This is likely an attendance query, not financial
    }

    // If it mentions paid/unpaid without attendance context, block it
    if (hasPaidTerms && !hasAttendanceContext) {
      return true;
    }

    return false;
  }

  async generateQuery(userMessage, cardType, tableName = 'daily_worker_summary') {
    console.log('\n🔄 QUERY GENERATION PIPELINE START');
    console.log('=====================================');
    console.log(`📝 User Message: "${userMessage}"`);
    console.log(`📊 Card Type: ${cardType}`);
    console.log(`📋 Table: ${tableName}`);

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
      const availableTables = Object.keys(this.tableSchema).map(name => {
        const table = this.tableSchema[name];
        return `${table.name}: ${table.description}\nColumns: ${table.columns.map(col => `${col.name} (${col.type})`).join(', ')}`;
      }).join('\n\n');

      // Check if this is a genuine financial data request (not attendance-related)
      const isFinancialRequest = this.isGenuineFinancialRequest(userMessage);

      if (isFinancialRequest) {
        console.log('🚫 FINANCIAL REQUEST DETECTED - Request blocked before LLM generation');
        console.log(`❌ Request appears to be asking for financial data not available in workforce tracking system`);
        console.log('=====================================\n');

        return {
          success: false,
          error: 'Financial data is not available in this workforce tracking system. This database only contains attendance, work hours, and location tracking data. Please try asking about work hours, attendance rates, or staff performance metrics instead.',
          query: null,
          explanation: 'Financial data request cannot be fulfilled',
          cardType: cardType,
          columns: [],
          tableName: tableName
        };
      }

      console.log('✅ Pre-validation passed - proceeding to LLM generation');

      const prompt = `
USER REQUEST: "${userMessage}"
CARD TYPE: ${cardType}

CRITICAL: Before generating any query, check if the user is asking about financial data (payments, salaries, wages, etc.). If so, do NOT generate a query - instead throw an error explaining that financial data is not available.

Generate a ClickHouse SQL query that:
1. Answers the user's request for a ${cardType} visualization
2. Can use tables: daily_worker_summary, client_projects
3. Returns clean SQL without markdown or explanations
4. Is optimized for ${cardType} display
5. ${cardType === 'kpi' ? 'MANDATORY: Use AS aliases with human-readable titles (e.g., COUNT(*) AS "Total Staff Count")' : 'NEVER use column aliases (AS) - use original column names only'}
6. For project-related queries, JOIN with client_projects when needed
7. Remember: checkin_project_id/checkout_project_id NULL or -1 = outside project location
8. CRITICAL: Use work_date with ClickHouse date functions for time filtering (e.g., toYYYYMM(work_date))
9. NEVER use columns like DAY, WEEK, MONTH, YEAR - these do NOT exist! Use work_date instead!
10. NEVER use financial columns like Payment, Salary, Wage - they do NOT exist!
${cardType === 'kpi' ? '11. KPI REQUIREMENT: Return single row with human-readable AS alias (e.g., "SELECT COUNT(*) AS \\"People Needing Attention\\"")' : ''}

AVAILABLE TABLES:
${availableTables}

IMPORTANT: Use exact column names from the schema. ${cardType === 'kpi' ? 'FOR KPI: Use AS aliases with natural language display names in quotes.' : 'Do NOT rename columns with AS aliases.'}
CRITICAL COLUMN RULES:
- NEVER use DAY, WEEK, MONTH, YEAR as column names - they DO NOT EXIST!
- NEVER use Payment, Salary, Wage, Pay, Earnings - they DO NOT EXIST!
- Always use work_date with functions: toYear(work_date), toMonth(work_date), toDayOfWeek(work_date)
- For weekly filtering: work_date >= toMonday(today()) AND work_date < addDays(toMonday(today()), 7)

Examples:
- Use "checkin_lat" NOT "checkin_lat AS lat"
- Use "SUM(total_work_hours)" NOT "SUM(total_work_hours) AS total_hours"
- Use "COUNT(*)" NOT "COUNT(*) AS count" or "COUNT(*) days_present"
- Use "toYear(work_date)" NOT "YEAR"
- Use "toDayOfWeek(work_date)" NOT "DAY"
- CORRECT: "SELECT staff_name, SUM(total_work_hours), COUNT(*) FROM..."
- WRONG: "SELECT staff_name, SUM(total_work_hours) total_hours, COUNT(*) days FROM..."
- For project queries: "JOIN client_projects p ON d.checkin_project_id = p.project_id"

TIME HANDLING RULES:
- For time-based aggregations, use toHour() function: "toHour(checkin_time)"
- For time comparisons, convert to comparable format: "formatDateTime(checkin_time, '%H:%M')"
- NEVER use AVG() directly on DateTime fields - convert first: "AVG(toUInt32(toHour(checkin_time)))"
- For "earliest/latest" times, use MIN()/MAX(): "MIN(checkin_time)", "MAX(checkout_time)"
- For time differences, use dateDiff(): "dateDiff('minute', checkin_time, checkout_time)"

Generate ONLY the SQL query using the generate_clickhouse_query tool.`;

      // Run the agent
      console.log('🤖 Calling LLM Agent for query generation...');
      const result = await run(this.queryAgent, prompt);

      // Extract the tool result
      if (result.messages && result.messages.length > 0) {
        for (const message of result.messages) {
          if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
              if (toolCall.function && toolCall.function.name === 'generate_clickhouse_query') {
                const toolResult = JSON.parse(toolCall.function.arguments);

                console.log('✅ LLM GENERATED QUERY:');
                console.log(`🔍 Query: ${toolResult.query}`);
                console.log(`💭 Explanation: ${toolResult.explanation}`);
                console.log(`📊 Card Type: ${toolResult.cardType}`);
                console.log(`🏷️ Columns: ${toolResult.columns.join(', ')}`);
                console.log('=====================================\n');

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

  async correctQueryWithLLM(originalQuery, clickhouseError, userMessage, cardType) {
    try {
      const startTime = Date.now();
      console.log('🔧 CORRECTION AGENT START');
      console.log(`🔍 Original Query: ${originalQuery}`);
      console.log(`❌ ClickHouse Error: ${clickhouseError}`);

      // Create correction prompt
      const availableTables = Object.keys(this.tableSchema).map(name => {
        const table = this.tableSchema[name];
        return `${table.name}: ${table.description}\nColumns: ${table.columns.map(col => `${col.name} (${col.type})`).join(', ')}`;
      }).join('\n\n');

      const prompt = `
ORIGINAL USER REQUEST: "${userMessage}"
CARD TYPE: ${cardType}
GENERATED QUERY: "${originalQuery}"
CLICKHOUSE ERROR: "${clickhouseError}"

AVAILABLE SCHEMA:
${availableTables}

CORRECTION TASK:
Analyze the ClickHouse error message and correct the query to work properly.
Focus on the specific error encountered, not general validation.

Key considerations:
1. What exactly did ClickHouse complain about?
2. How can we fix this specific error while maintaining user intent?
3. Is this error correctable or does it indicate a fundamental limitation?

Use the correct_clickhouse_query tool to provide your correction.`;

      // Run the correction agent
      const result = await run(this.correctionAgent, prompt);

      // Extract the tool result
      if (result.messages && result.messages.length > 0) {
        for (const message of result.messages) {
          if (message.tool_calls && message.tool_calls.length > 0) {
            for (const toolCall of message.tool_calls) {
              if (toolCall.function && toolCall.function.name === 'correct_clickhouse_query') {
                const toolResult = JSON.parse(toolCall.function.arguments);

                const correctionTime = Date.now() - startTime;
                console.log(`🔧 CORRECTION COMPLETED in ${correctionTime}ms`);
                console.log(`✅ Can Correct: ${toolResult.canCorrect}`);
                console.log(`📝 Error Type: ${toolResult.errorType}`);
                if (toolResult.correctedQuery) {
                  console.log(`🔧 Corrected Query: ${toolResult.correctedQuery}`);
                }

                return {
                  canCorrect: toolResult.canCorrect,
                  correctedQuery: toolResult.correctedQuery,
                  errorType: toolResult.errorType,
                  explanation: toolResult.explanation,
                  userFriendlyMessage: toolResult.userFriendlyMessage,
                  suggestedAlternatives: toolResult.suggestedAlternatives,
                  correctionTimeMs: correctionTime
                };
              }
            }
          }
        }
      }

      console.log('❌ CORRECTION FAILED - No tool result found');
      return {
        canCorrect: false,
        correctedQuery: null,
        errorType: 'other',
        explanation: 'Correction agent failed to provide a result',
        userFriendlyMessage: 'Unable to automatically correct this query. Please try rephrasing your request.',
        suggestedAlternatives: null,
        correctionTimeMs: Date.now() - startTime
      };

    } catch (error) {
      console.error('Error in query correction:', error);
      return {
        canCorrect: false,
        correctedQuery: null,
        errorType: 'other',
        explanation: `Correction failed: ${error.message}`,
        userFriendlyMessage: 'An error occurred while trying to correct the query. Please try rephrasing your request.',
        suggestedAlternatives: null,
        correctionTimeMs: Date.now() - startTime
      };
    }
  }

  // Basic safety validation (kept for safety checks in generation)
  basicValidation(query) {
    if (!query || typeof query !== 'string') {
      return { valid: false, error: 'Query must be a non-empty string' };
    }

    if (!query.trim().toUpperCase().startsWith('SELECT')) {
      return { valid: false, error: 'Only SELECT queries are allowed' };
    }

    return { valid: true, query: query };
  }

  async executeGeneratedQuery(queryResult) {
    try {
      const startTime = Date.now();

      if (!queryResult.success || !queryResult.query) {
        throw new Error('Invalid query result provided');
      }

      console.log('\n⚡ DIRECT QUERY EXECUTION START');
      console.log('===============================');
      console.log(`🚀 Query: ${queryResult.query}`);

      // Execute the query directly in ClickHouse (fail-fast approach)
      const result = await clickhouseService.executeCustomQuery(queryResult.query);
      const executionTime = Date.now() - startTime;

      if (result.success) {
        console.log(`✅ EXECUTION SUCCESSFUL in ${executionTime}ms - Returned ${result.data ? result.data.length : 0} rows`);
        console.log('===============================\n');

        return {
          success: true,
          data: result.data,
          error: null,
          query: queryResult.query,
          explanation: queryResult.explanation,
          cardType: queryResult.cardType,
          columns: queryResult.columns,
          metadata: {
            rowCount: result.data ? result.data.length : 0,
            executionTimeMs: executionTime,
            generatedAt: new Date().toISOString()
          }
        };
      } else {
        console.log(`❌ EXECUTION FAILED in ${executionTime}ms: ${result.error}`);
        console.log('===============================\n');

        return {
          success: false,
          data: [],
          error: result.error,
          query: queryResult.query,
          explanation: queryResult.explanation,
          cardType: queryResult.cardType,
          columns: queryResult.columns,
          metadata: {
            executionTimeMs: executionTime,
            failedAt: new Date().toISOString()
          }
        };
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;
      console.error('Error executing generated query:', error);
      console.log('===============================\n');

      return {
        success: false,
        error: error.message,
        data: [],
        query: queryResult.query,
        explanation: queryResult.explanation,
        cardType: queryResult.cardType,
        columns: queryResult.columns,
        metadata: {
          executionTimeMs: executionTime,
          failedAt: new Date().toISOString()
        }
      };
    }
  }

  // Main method implementing the optimized fail-fast flow
  async processUserRequest(userMessage, cardType, tableName = 'daily_worker_summary') {
    try {
      const totalStartTime = Date.now();

      console.log('\n🚀 OPTIMIZED LLM SERVICE PIPELINE START');
      console.log('=======================================');
      console.log(`📝 User Message: "${userMessage}"`);
      console.log(`📊 Card Type: ${cardType}`);
      console.log(`📋 Table: ${tableName}`);

      // Step 1: Generate the query (1 LLM call)
      const generationStartTime = Date.now();
      const queryResult = await this.generateQuery(userMessage, cardType, tableName);
      const generationTime = Date.now() - generationStartTime;

      if (!queryResult.success) {
        console.log(`❌ QUERY GENERATION FAILED in ${generationTime}ms: ${queryResult.error}`);
        console.log('=======================================\n');
        return {
          ...queryResult,
          metadata: {
            totalTimeMs: Date.now() - totalStartTime,
            generationTimeMs: generationTime,
            executionTimeMs: 0,
            correctionTimeMs: 0
          }
        };
      }

      console.log(`✅ QUERY GENERATED in ${generationTime}ms`);

      // Step 2: Execute directly in ClickHouse (fail-fast approach)
      const firstExecutionResult = await this.executeGeneratedQuery(queryResult);

      if (firstExecutionResult.success) {
        // Success path - 70-80% of queries should reach here
        const totalTime = Date.now() - totalStartTime;
        console.log(`🎉 FAST PATH SUCCESS in ${totalTime}ms (1 LLM call + 1 DB call)`);
        console.log('=======================================\n');

        return {
          ...firstExecutionResult,
          metadata: {
            ...firstExecutionResult.metadata,
            totalTimeMs: totalTime,
            generationTimeMs: generationTime,
            correctionTimeMs: 0,
            flowType: 'fast_path'
          }
        };
      }

      console.log(`❌ FIRST EXECUTION FAILED: ${firstExecutionResult.error}`);
      console.log('🔄 ATTEMPTING ERROR CORRECTION...');

      // Step 3: If execution failed, use correction agent (1 more LLM call)
      const correctionResult = await this.correctQueryWithLLM(
        queryResult.query,
        firstExecutionResult.error,
        userMessage,
        cardType
      );

      if (!correctionResult.canCorrect || !correctionResult.correctedQuery) {
        // Cannot correct the error
        const totalTime = Date.now() - totalStartTime;
        console.log(`❌ CORRECTION NOT POSSIBLE in ${totalTime}ms`);
        console.log(`💭 User Message: ${correctionResult.userFriendlyMessage}`);
        console.log('=======================================\n');

        return {
          success: false,
          error: correctionResult.userFriendlyMessage,
          data: [],
          query: queryResult.query,
          explanation: queryResult.explanation,
          cardType: queryResult.cardType,
          columns: queryResult.columns,
          metadata: {
            totalTimeMs: totalTime,
            generationTimeMs: generationTime,
            executionTimeMs: firstExecutionResult.metadata?.executionTimeMs || 0,
            correctionTimeMs: correctionResult.correctionTimeMs || 0,
            flowType: 'correction_failed',
            errorType: correctionResult.errorType,
            originalError: firstExecutionResult.error
          },
          errorDetails: {
            errorType: correctionResult.errorType,
            explanation: correctionResult.explanation,
            suggestedAlternatives: correctionResult.suggestedAlternatives
          }
        };
      }

      console.log(`✅ CORRECTION SUCCESSFUL - Retrying with corrected query`);

      // Step 4: Execute the corrected query
      const correctedQueryResult = {
        ...queryResult,
        query: correctionResult.correctedQuery
      };

      const secondExecutionResult = await this.executeGeneratedQuery(correctedQueryResult);
      const totalTime = Date.now() - totalStartTime;

      if (secondExecutionResult.success) {
        console.log(`🎉 CORRECTION PATH SUCCESS in ${totalTime}ms (2 LLM calls + 2 DB calls)`);
        console.log('=======================================\n');

        return {
          ...secondExecutionResult,
          metadata: {
            ...secondExecutionResult.metadata,
            totalTimeMs: totalTime,
            generationTimeMs: generationTime,
            correctionTimeMs: correctionResult.correctionTimeMs || 0,
            flowType: 'correction_success',
            originalQuery: queryResult.query,
            correctedQuery: correctionResult.correctedQuery
          }
        };
      } else {
        console.log(`❌ CORRECTED QUERY ALSO FAILED in ${totalTime}ms`);
        console.log('=======================================\n');

        return {
          success: false,
          error: `Even the corrected query failed: ${secondExecutionResult.error}`,
          data: [],
          query: correctionResult.correctedQuery,
          explanation: queryResult.explanation,
          cardType: queryResult.cardType,
          columns: queryResult.columns,
          metadata: {
            totalTimeMs: totalTime,
            generationTimeMs: generationTime,
            correctionTimeMs: correctionResult.correctionTimeMs || 0,
            flowType: 'correction_also_failed',
            originalQuery: queryResult.query,
            correctedQuery: correctionResult.correctedQuery,
            originalError: firstExecutionResult.error,
            correctedError: secondExecutionResult.error
          }
        };
      }

    } catch (error) {
      const totalTime = Date.now() - totalStartTime;
      console.error('Error in optimized pipeline:', error);
      console.log('=======================================\n');

      return {
        success: false,
        error: error.message,
        data: [],
        query: null,
        explanation: null,
        cardType: cardType,
        columns: [],
        metadata: {
          totalTimeMs: totalTime,
          flowType: 'pipeline_error'
        }
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