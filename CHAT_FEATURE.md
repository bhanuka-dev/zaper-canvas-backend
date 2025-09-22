# 🤖 Chat Feature Documentation

## Overview

The Zaper Canvas Backend now includes an LLM-powered chat feature that allows users to generate ClickHouse queries using natural language. This feature supports different card types (table, bar, line, pie, map, kpi) and generates optimized queries for each visualization type.

## 🚀 Features Implemented

### 1. LLM Service Module (`services/llm-service.js`)
- **OpenAI Agents SDK Integration**: Uses the latest OpenAI Agents framework
- **Card-Type Specific Query Generation**: Optimized queries for different visualization types
- **Schema-Aware**: Full knowledge of the `daily_worker_summary` table structure
- **Security**: Only allows SELECT statements, validates table names
- **Error Handling**: Comprehensive error handling and fallback responses

### 2. Chat API Endpoints

#### `POST /api/chat`
Main endpoint for generating and executing queries based on user messages.

**Request Body:**
```json
{
  "message": "Show me total hours by staff",
  "cardType": "table",
  "tableName": "daily_worker_summary"
}
```

**Response:**
```json
{
  "success": true,
  "data": [...], // Query results
  "query": "SELECT staff_name, SUM(total_work_hours)...",
  "explanation": "This query shows total hours worked by each staff member",
  "cardType": "table",
  "columns": ["staff_name", "total_hours"],
  "metadata": {
    "rowCount": 25,
    "generatedAt": "2025-09-21T07:42:09.856Z"
  },
  "tableName": "daily_worker_summary"
}
```

#### `GET /api/chat/schemas`
Returns all available table schemas for the LLM service.

#### `GET /api/chat/schemas/:tableName`
Returns schema for a specific table.

### 3. Supported Card Types

#### 📊 Table Card
- Returns tabular data with appropriate columns
- Includes pagination-friendly structure
- Limited to 50-100 rows for performance

#### 📈 Bar/Line/Pie Charts
- Returns exactly 2 columns: labels and values
- Uses GROUP BY for aggregations
- Limited to 10-20 data points
- Optimized for visualization

#### 🗺️ Map Card
- **Real Coordinates**: Uses actual latitude/longitude from check-in/check-out locations
- **Location Data**: `checkin_lat`, `checkin_lng`, `checkout_lat`, `checkout_lng`
- **Geographic Visualization**: Perfect for mapping actual work locations
- **Aggregated Data**: Can group by coordinates for site-level metrics

#### 📋 KPI Card
- Returns single aggregate values
- Uses COUNT(), SUM(), AVG(), MAX(), MIN()
- Multiple related KPIs in one query

## 🛠️ Setup Instructions

### 1. Dependencies Already Installed
```bash
# Already completed
npm install @openai/agents zod@3
```

### 2. Environment Configuration
Add your OpenAI API key to `.env`:
```bash
# Add this to your .env file
OPENAI_API_KEY=your_actual_openai_api_key_here
```

### 3. Restart Server
```bash
npm run dev
```

### 📍 NEW: Location Endpoint

Access real GPS coordinates directly:

```bash
# Get check-in locations with basic info
GET /api/tables/daily_worker_summary/locations?type=checkin&limit=50

# Get both check-in and check-out locations with all metrics
GET /api/tables/daily_worker_summary/locations?type=both&includeMetrics=all

# Get check-out locations with earnings data
GET /api/tables/daily_worker_summary/locations?type=checkout&includeMetrics=earnings
```

**Parameters:**
- `type`: `checkin`, `checkout`, or `both`
- `includeMetrics`: `basic`, `earnings`, `hours`, or `all`
- `limit`: Number of records (default: 100)

## 🧪 Testing Examples

### Test Different Card Types

#### Table Card Example
```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Show me staff details with their total hours",
    "cardType": "table"
  }'
```

#### Bar Chart Example
```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Top 10 clients by total earnings",
    "cardType": "bar"
  }'
```

#### Line Chart Example
```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Monthly attendance trend over time",
    "cardType": "line"
  }'
```

#### KPI Example
```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Overall attendance rate and total employees",
    "cardType": "kpi"
  }'
```

#### Map Examples (NEW!)
```bash
# Show check-in locations on map
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "show check-in locations with coordinates",
    "cardType": "map"
  }'

# Work sites grouped by location with earnings
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "show work sites by total earnings with coordinates",
    "cardType": "map"
  }'
```

## 📊 Available Data Fields

The `daily_worker_summary` table contains:

### 👤 Staff & Client Info
- `staff_id`, `staff_name` - Staff identification
- `client_id`, `client_name` - Client identification

### 📅 Time Dimensions
- `work_date` - Daily work date
- `work_month` - YYYYMM format for monthly analysis
- `work_year` - Year for yearly aggregations
- `work_quarter` - Quarter (1-4)
- `weekday` - Day of week (1=Monday, 7=Sunday)

### ⏰ Time Tracking
- `checkin_time`, `checkout_time` - Daily timestamps
- `total_work_hours` - Total daily work hours
- `total_break_hours` - Break time taken
- `overtime_hours` - Overtime hours worked
- `effective_work_hours` - Net productive hours

### 📍 Location Data (NEW!)
- `checkin_lat`, `checkin_lng` - Check-in GPS coordinates
- `checkout_lat`, `checkout_lng` - Check-out GPS coordinates
- Perfect for real-time location mapping and geofencing

### 💰 Financial Data
- `work_amount` - Daily work earnings
- `overtime_amount` - Overtime earnings
- `fine_amount` - Any fines applied
- `total_earnings` - Net daily earnings

### 📈 Performance Metrics
- `is_present` - Attendance flag (1/0)
- `attendance_score` - Performance score
- `leave_type` - Type of leave if absent

## 🎯 Example Queries the System Can Generate

### Attendance Analysis
- "Show attendance rate by month"
- "Which staff have the highest attendance?"
- "Total absent days by leave type"

### Financial Analysis
- "Top earning staff members"
- "Monthly revenue trend"
- "Overtime costs by client"

### Productivity Analysis
- "Average working hours by staff"
- "Most productive days of the week"
- "Break time patterns"

### Client Analysis
- "Revenue by client"
- "Client engagement trends"
- "Hours worked per client"

## 🔒 Security Features

1. **Query Validation**: Only SELECT statements allowed
2. **Table Validation**: Validates table names against schema
3. **SQL Injection Prevention**: Parameterized queries and validation
4. **Rate Limiting**: Existing rate limiting applies to chat endpoints
5. **Error Handling**: Secure error messages without sensitive data exposure

## 🚀 Frontend Integration

Your Canvas frontend can now integrate this chat feature by:

1. **Adding Chat UI**: Add a chat input to each card type
2. **Sending Requests**: POST to `/api/chat` with user message and card type
3. **Handling Responses**: Use the returned data to populate the appropriate visualization
4. **Error Handling**: Display user-friendly error messages

## 🔄 Next Steps

1. Add your OpenAI API key to `.env`
2. Restart your server
3. Test the endpoints with curl commands above
4. Integrate into your frontend Canvas application
5. Consider adding more tables to the schema as your database grows

## 📝 Notes

- The system is designed to be extensible for additional tables
- Query generation is optimized for ClickHouse-specific functions
- All generated queries include proper LIMIT clauses for performance
- The LLM has deep knowledge of your workforce analytics domain