# MCP Database Server

> Fork of [executeautomation/mcp-database-server](https://github.com/executeautomation/mcp-database-server) with extended SQL Server features including automatic backups, object management, and more.

This MCP (Model Context Protocol) server provides database access capabilities to Claude, supporting SQLite, SQL Server, PostgreSQL, and MySQL databases.

## Installation

1. Clone the repository:
```
git clone https://github.com/FernanApps/mcp-database-server.git
cd mcp-database-server
```

2. Install dependencies:
```
npm install
```

3. Build the project:
```
npm run build
```

## Usage

### SQLite Database

To use with an SQLite database:

```
node dist/src/index.js /path/to/your/database.db
```

### SQL Server Database

To use with a SQL Server database:

```
node dist/src/index.js --sqlserver --server <server-name> --database <database-name> [--user <username> --password <password>]
```

Required parameters:
- `--server`: SQL Server host name or IP address
- `--database`: Name of the database

Optional parameters:
- `--user`: Username for SQL Server authentication (if not provided, Windows Authentication will be used)
- `--password`: Password for SQL Server authentication
- `--port`: Port number (default: 1433)

### PostgreSQL Database

To use with a PostgreSQL database:

```
node dist/src/index.js --postgresql --host <host-name> --database <database-name> [--user <username> --password <password>]
```

Required parameters:
- `--host`: PostgreSQL host name or IP address
- `--database`: Name of the database

Optional parameters:
- `--user`: Username for PostgreSQL authentication
- `--password`: Password for PostgreSQL authentication
- `--port`: Port number (default: 5432)
- `--ssl`: Enable SSL connection (true/false)
- `--connection-timeout`: Connection timeout in milliseconds (default: 30000)

### MySQL Database

#### Standard Authentication

To use with a MySQL database:

```
node dist/src/index.js --mysql --host <host-name> --database <database-name> --port <port> [--user <username> --password <password>]
```

Required parameters:
- `--host`: MySQL host name or IP address
- `--database`: Name of the database
- `--port`: Port number (default: 3306)

Optional parameters:
- `--user`: Username for MySQL authentication
- `--password`: Password for MySQL authentication
- `--ssl`: Enable SSL connection (true/false or object)
- `--connection-timeout`: Connection timeout in milliseconds (default: 30000)

#### AWS IAM Authentication

For Amazon RDS MySQL instances with IAM database authentication:

**Prerequisites:**
- AWS credentials must be configured (the RDS Signer uses the default credential provider chain)
- Configure using one of these methods:
  - `aws configure` (uses default profile)
  - `AWS_PROFILE=myprofile` environment variable
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables
  - IAM roles (if running on EC2)

```
node dist/src/index.js --mysql --aws-iam-auth --host <rds-endpoint> --database <database-name> --user <aws-username> --aws-region <region>
```

Required parameters:
- `--host`: RDS endpoint hostname
- `--database`: Name of the database
- `--aws-iam-auth`: Enable AWS IAM authentication
- `--user`: AWS IAM username (also the database user)
- `--aws-region`: AWS region where RDS instance is located

Note: SSL is automatically enabled for AWS IAM authentication

## Configuring Claude Desktop

### Using from GitHub (Recommended for Forks)

You can use this MCP server directly from GitHub without installing it:

**For Claude Desktop (macOS/Linux):**
```json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": [
        "-y",
        "github:FernanApps/mcp-database-server#main",
        "--sqlserver",
        "--server", "localhost",
        "--database", "your-database",
        "--user", "sa",
        "--password", "your-password"
      ]
    }
  }
}
```

**For Claude Code on Windows (.mcp.json):**
```json
{
  "mcpServers": {
    "database": {
      "command": "cmd",
      "args": [
        "/c", "npx",
        "-y",
        "github:FernanApps/mcp-database-server#main",
        "--sqlserver",
        "--server", "localhost",
        "--database", "your-database",
        "--user", "sa",
        "--password", "your-password"
      ]
    }
  }
}
```

> **Note:** The `#main` ensures you always get the latest version from the main branch. You can also use a specific commit hash like `#a3f948c` for version pinning.

To check the installed version:
```bash
npx -y github:FernanApps/mcp-database-server#main --version
```

### Local Development Configuration

For local development, configure Claude Desktop to use your locally built version:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js", 
        "/path/to/your/database.db"
      ]
    },
    "sqlserver": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--sqlserver",
        "--server", "your-server-name",
        "--database", "your-database-name",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "postgresql": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--postgresql",
        "--host", "your-host-name",
        "--database", "your-database-name",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "mysql": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--mysql",
        "--host", "your-host-name",
        "--database", "your-database-name",
        "--port", "3306",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "mysql-aws": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--mysql",
        "--aws-iam-auth",
        "--host", "your-rds-endpoint.region.rds.amazonaws.com",
        "--database", "your-database-name",
        "--user", "your-aws-username",
        "--aws-region", "us-east-1"
      ]
    }
  }
}
```

The Claude Desktop configuration file is typically located at:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

## Available Database Tools

The MCP Database Server provides the following tools that Claude can use:

### General Tools (All Databases)

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `read_query` | Execute SELECT queries to read data | `query`: SQL SELECT statement |
| `write_query` | Execute INSERT, UPDATE, or DELETE queries | `query`: SQL modification statement |
| `create_table` | Create new tables in the database | `query`: CREATE TABLE statement |
| `alter_table` | Modify existing table schema (creates backup on SQL Server) | `query`: ALTER TABLE statement |
| `drop_table` | Remove a table from the database (creates backup on SQL Server) | `table_name`: Name of table<br>`confirm`: Safety flag (must be true) |
| `list_tables` | Get a list of all tables | None |
| `describe_table` | View schema information for a table | `table_name`: Name of table |
| `export_query` | Export query results as CSV/JSON | `query`: SQL SELECT statement<br>`format`: "csv" or "json" |
| `append_insight` | Add a business insight to memo | `insight`: Text of insight |
| `list_insights` | List all business insights | None |

### SQL Server Exclusive Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `get_object_definition` | Get source code of SP, function, view, or trigger | `object_name`: Name of object |
| `list_objects` | List database objects by type | `object_type`: PROCEDURE, FUNCTION, VIEW, TRIGGER |
| `search_in_objects` | Search text within object definitions | `search_text`: Text to search |
| `get_dependencies` | Get object dependencies | `object_name`: Name of object |
| `get_table_info` | Get detailed table information with indexes and FKs | `table_name`: Name of table |
| `get_table_structure` | Generate CREATE TABLE script | `table_name`: Name of table |
| `validate_sql` | Validate SQL syntax without executing | `query`: SQL to validate |
| `get_procedure_info` | Get stored procedure info with parameters | `procedure_name`: Name of SP |
| `exec_procedure` | Execute a stored procedure | `procedure_name`: Name of SP |
| `alter_procedure` | Modify SP with automatic backup | `procedure_name`, `new_definition`, `confirm` |
| `alter_function` | Modify function with automatic backup | `function_name`, `new_definition`, `confirm` |
| `alter_view` | Modify view with automatic backup | `view_name`, `new_definition`, `confirm` |
| `create_procedure` | Create new stored procedure | `procedure_name`, `definition`, `confirm` |
| `create_function` | Create new function | `function_name`, `definition`, `confirm` |
| `create_view` | Create new view | `view_name`, `definition`, `confirm` |
| `drop_object` | Drop SP, function, view, or trigger with backup | `object_name`, `object_type`, `confirm` |
| `truncate_table` | Remove all rows with structure backup | `table_name`, `confirm` |
| `list_backups` | List all backups | `object_name` (optional) |
| `get_backup` | Get backup content | `backup_id` |
| `restore_from_backup` | Restore object from backup | `backup_id`, `confirm` |
| `diff_backups` | Compare two backup versions | `backup_id_old`, `backup_id_new` |
| `get_backup_statistics` | Get backup statistics | None |
| `cleanup_backups` | Remove old backups | `days` (optional) |

For practical examples of how to use these tools with Claude, see [Usage Examples](docs/usage-examples.md).

## Additional Documentation

- [SQL Server Setup Guide](docs/sql-server-setup.md): Details on connecting to SQL Server databases
- [PostgreSQL Setup Guide](docs/postgresql-setup.md): Details on connecting to PostgreSQL databases
- [Usage Examples](docs/usage-examples.md): Example queries and commands to use with Claude

## Development

To run the server in development mode:

```
npm run dev
```

To watch for changes during development:

```
npm run watch
```

## Requirements

- Node.js 18+
- For SQL Server connectivity: SQL Server 2012 or later
- For PostgreSQL connectivity: PostgreSQL 9.5 or later

## License

MIT
