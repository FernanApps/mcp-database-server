import { formatErrorResponse } from '../utils/formatUtils.js';

// Import all tool implementations
import { readQuery, writeQuery, exportQuery } from '../tools/queryTools.js';
import { createTable, alterTable, dropTable, listTables, describeTable } from '../tools/schemaTools.js';
import { appendInsight, listInsights } from '../tools/insightTools.js';

// Import new SQL Server tools
import { getObjectDefinition, listObjects, searchInObjects } from '../tools/objectTools.js';
import { getDependencies, getTableInfo } from '../tools/dependencyTools.js';
import { validateSql } from '../tools/validationTools.js';
import {
  alterProcedure,
  alterFunction,
  alterView,
  dropObject,
  createProcedure,
  createFunction,
  createView,
} from '../tools/alterTools.js';
import { execProcedure, getProcedureInfo } from '../tools/execTools.js';
import {
  listBackups,
  restoreFromBackup,
  diffBackups,
  getBackup,
  getBackupStatistics,
  cleanupBackups,
} from '../tools/backupTools.js';

/**
 * Handle listing available tools
 * @returns List of available tools
 */
export function handleListTools() {
  return {
    tools: [
      // ========================================
      // EXISTING TOOLS
      // ========================================
      {
        name: "read_query",
        description: "Execute SELECT queries to read data from the database",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The SELECT query to execute" },
          },
          required: ["query"],
        },
      },
      {
        name: "write_query",
        description: "Execute INSERT, UPDATE, or DELETE queries",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The INSERT, UPDATE, or DELETE query to execute" },
          },
          required: ["query"],
        },
      },
      {
        name: "create_table",
        description: "Create new tables in the database",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The CREATE TABLE statement" },
          },
          required: ["query"],
        },
      },
      {
        name: "alter_table",
        description: "Modify existing table schema (add columns, rename tables, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The ALTER TABLE statement" },
          },
          required: ["query"],
        },
      },
      {
        name: "drop_table",
        description: "Remove a table from the database with safety confirmation",
        inputSchema: {
          type: "object",
          properties: {
            table_name: { type: "string", description: "Name of the table to drop" },
            confirm: { type: "boolean", description: "Set to true to confirm the operation" },
          },
          required: ["table_name", "confirm"],
        },
      },
      {
        name: "export_query",
        description: "Export query results to various formats (CSV, JSON)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The SELECT query to export" },
            format: { type: "string", enum: ["csv", "json"], description: "Output format" },
          },
          required: ["query", "format"],
        },
      },
      {
        name: "list_tables",
        description: "Get a list of all tables in the database",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "describe_table",
        description: "View schema information for a specific table",
        inputSchema: {
          type: "object",
          properties: {
            table_name: { type: "string", description: "Name of the table to describe" },
          },
          required: ["table_name"],
        },
      },
      {
        name: "append_insight",
        description: "Add a business insight to the memo",
        inputSchema: {
          type: "object",
          properties: {
            insight: { type: "string", description: "The insight text to add" },
          },
          required: ["insight"],
        },
      },
      {
        name: "list_insights",
        description: "List all business insights in the memo",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // ========================================
      // NEW SQL SERVER TOOLS - READ ONLY
      // ========================================
      {
        name: "get_object_definition",
        description: "[SQL Server] Get the source code/definition of a stored procedure, function, view, or trigger",
        inputSchema: {
          type: "object",
          properties: {
            object_name: { type: "string", description: "Name of the database object" },
            object_type: {
              type: "string",
              enum: ["PROCEDURE", "FUNCTION", "VIEW", "TRIGGER"],
              description: "Type of object (auto-detected if not specified)",
            },
          },
          required: ["object_name"],
        },
      },
      {
        name: "list_objects",
        description: "[SQL Server] List database objects (procedures, functions, views, triggers) with optional filtering",
        inputSchema: {
          type: "object",
          properties: {
            object_type: {
              type: "string",
              enum: ["PROCEDURE", "FUNCTION", "VIEW", "TRIGGER", "ALL"],
              description: "Type of objects to list (default: ALL)",
            },
            schema: { type: "string", description: "Schema name (default: dbo)" },
            filter: { type: "string", description: "Filter pattern for object names (LIKE pattern)" },
          },
        },
      },
      {
        name: "search_in_objects",
        description: "[SQL Server] Search for text within the code of stored procedures, functions, views, and triggers",
        inputSchema: {
          type: "object",
          properties: {
            search_text: { type: "string", description: "Text to search for in object definitions" },
            object_types: {
              type: "array",
              items: { type: "string", enum: ["PROCEDURE", "FUNCTION", "VIEW", "TRIGGER"] },
              description: "Types of objects to search in (default: all types)",
            },
            case_sensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
          },
          required: ["search_text"],
        },
      },
      {
        name: "get_dependencies",
        description: "[SQL Server] Get the dependencies of a database object (what it uses and what uses it)",
        inputSchema: {
          type: "object",
          properties: {
            object_name: { type: "string", description: "Name of the database object" },
            direction: {
              type: "string",
              enum: ["uses", "used_by", "both"],
              description: "Direction of dependencies to retrieve (default: both)",
            },
          },
          required: ["object_name"],
        },
      },
      {
        name: "get_table_info",
        description: "[SQL Server] Get extended information about a table including columns, indexes, foreign keys, and references",
        inputSchema: {
          type: "object",
          properties: {
            table_name: { type: "string", description: "Name of the table" },
            include_indexes: { type: "boolean", description: "Include index information (default: true)" },
            include_foreign_keys: { type: "boolean", description: "Include foreign key information (default: true)" },
            include_row_count: { type: "boolean", description: "Include row count (default: false, can be slow)" },
          },
          required: ["table_name"],
        },
      },
      {
        name: "validate_sql",
        description: "[SQL Server] Validate SQL syntax without executing the query",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The SQL query to validate" },
          },
          required: ["query"],
        },
      },

      // ========================================
      // NEW SQL SERVER TOOLS - WITH BACKUP
      // ========================================
      {
        name: "alter_procedure",
        description: "[SQL Server] Modify an existing stored procedure (creates automatic backup before modification)",
        inputSchema: {
          type: "object",
          properties: {
            procedure_name: { type: "string", description: "Name of the procedure to modify" },
            new_definition: { type: "string", description: "Complete new definition (CREATE/ALTER PROCEDURE statement)" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["procedure_name", "new_definition", "confirm"],
        },
      },
      {
        name: "alter_function",
        description: "[SQL Server] Modify an existing function (creates automatic backup before modification)",
        inputSchema: {
          type: "object",
          properties: {
            function_name: { type: "string", description: "Name of the function to modify" },
            new_definition: { type: "string", description: "Complete new definition (CREATE/ALTER FUNCTION statement)" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["function_name", "new_definition", "confirm"],
        },
      },
      {
        name: "alter_view",
        description: "[SQL Server] Modify an existing view (creates automatic backup before modification)",
        inputSchema: {
          type: "object",
          properties: {
            view_name: { type: "string", description: "Name of the view to modify" },
            new_definition: { type: "string", description: "Complete new definition (CREATE/ALTER VIEW statement)" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["view_name", "new_definition", "confirm"],
        },
      },
      {
        name: "drop_object",
        description: "[SQL Server] Drop a database object (creates mandatory backup before deletion)",
        inputSchema: {
          type: "object",
          properties: {
            object_name: { type: "string", description: "Name of the object to drop" },
            object_type: {
              type: "string",
              enum: ["PROCEDURE", "FUNCTION", "VIEW", "TRIGGER"],
              description: "Type of object to drop",
            },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["object_name", "object_type", "confirm"],
        },
      },
      {
        name: "create_procedure",
        description: "[SQL Server] Create a new stored procedure",
        inputSchema: {
          type: "object",
          properties: {
            procedure_name: { type: "string", description: "Name of the new procedure" },
            definition: { type: "string", description: "Complete CREATE PROCEDURE statement" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["procedure_name", "definition", "confirm"],
        },
      },
      {
        name: "create_function",
        description: "[SQL Server] Create a new function",
        inputSchema: {
          type: "object",
          properties: {
            function_name: { type: "string", description: "Name of the new function" },
            definition: { type: "string", description: "Complete CREATE FUNCTION statement" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["function_name", "definition", "confirm"],
        },
      },
      {
        name: "create_view",
        description: "[SQL Server] Create a new view",
        inputSchema: {
          type: "object",
          properties: {
            view_name: { type: "string", description: "Name of the new view" },
            definition: { type: "string", description: "Complete CREATE VIEW statement" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["view_name", "definition", "confirm"],
        },
      },

      // ========================================
      // NEW SQL SERVER TOOLS - EXECUTION
      // ========================================
      {
        name: "exec_procedure",
        description: "[SQL Server] Execute a stored procedure with parameters",
        inputSchema: {
          type: "object",
          properties: {
            procedure_name: { type: "string", description: "Name of the procedure to execute" },
            parameters: {
              type: "object",
              description: "Parameters as key-value pairs (e.g., { '@Param1': value1 })",
              additionalProperties: true,
            },
            confirm: {
              type: "boolean",
              description: "Required for procedures that modify data",
            },
            timeout_seconds: {
              type: "number",
              description: "Execution timeout in seconds (default: 30, max: 120)",
            },
            max_rows: {
              type: "number",
              description: "Maximum rows to return (default: 1000, max: 10000)",
            },
          },
          required: ["procedure_name"],
        },
      },
      {
        name: "get_procedure_info",
        description: "[SQL Server] Get information about a stored procedure including its parameters",
        inputSchema: {
          type: "object",
          properties: {
            procedure_name: { type: "string", description: "Name of the procedure" },
          },
          required: ["procedure_name"],
        },
      },

      // ========================================
      // NEW SQL SERVER TOOLS - BACKUP MANAGEMENT
      // ========================================
      {
        name: "list_backups",
        description: "[SQL Server] List available backups with optional filtering",
        inputSchema: {
          type: "object",
          properties: {
            object_name: { type: "string", description: "Filter by object name" },
            object_type: { type: "string", description: "Filter by object type" },
            limit: { type: "number", description: "Maximum number of backups to return (default: 50)" },
          },
        },
      },
      {
        name: "restore_from_backup",
        description: "[SQL Server] Restore a database object from a backup (creates backup of current state first)",
        inputSchema: {
          type: "object",
          properties: {
            backup_id: { type: "string", description: "ID of the backup to restore" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["backup_id", "confirm"],
        },
      },
      {
        name: "diff_backups",
        description: "[SQL Server] Compare two backup versions or compare a backup with the current database version",
        inputSchema: {
          type: "object",
          properties: {
            backup_id_old: { type: "string", description: "ID of the older backup" },
            backup_id_new: {
              type: "string",
              description: "ID of the newer backup, or 'current' to compare with database",
            },
          },
          required: ["backup_id_old", "backup_id_new"],
        },
      },
      {
        name: "get_backup",
        description: "[SQL Server] Get the content of a specific backup",
        inputSchema: {
          type: "object",
          properties: {
            backup_id: { type: "string", description: "ID of the backup to retrieve" },
          },
          required: ["backup_id"],
        },
      },
      {
        name: "get_backup_statistics",
        description: "[SQL Server] Get statistics about all backups",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "cleanup_backups",
        description: "[SQL Server] Remove old backups based on age",
        inputSchema: {
          type: "object",
          properties: {
            days: { type: "number", description: "Remove backups older than this many days" },
            confirm: { type: "boolean", description: "REQUIRED: Set to true to confirm this operation" },
          },
          required: ["confirm"],
        },
      },
    ],
  };
}

/**
 * Handle tool call requests
 * @param name Name of the tool to call
 * @param args Arguments for the tool
 * @returns Tool execution result
 */
export async function handleToolCall(name: string, args: any) {
  try {
    switch (name) {
      // ========================================
      // EXISTING TOOLS
      // ========================================
      case "read_query":
        return await readQuery(args.query);

      case "write_query":
        return await writeQuery(args.query);

      case "create_table":
        return await createTable(args.query);

      case "alter_table":
        return await alterTable(args.query);

      case "drop_table":
        return await dropTable(args.table_name, args.confirm);

      case "export_query":
        return await exportQuery(args.query, args.format);

      case "list_tables":
        return await listTables();

      case "describe_table":
        return await describeTable(args.table_name);

      case "append_insight":
        return await appendInsight(args.insight);

      case "list_insights":
        return await listInsights();

      // ========================================
      // NEW SQL SERVER TOOLS - READ ONLY
      // ========================================
      case "get_object_definition":
        return await getObjectDefinition(args.object_name, args.object_type);

      case "list_objects":
        return await listObjects(args.object_type, args.schema, args.filter);

      case "search_in_objects":
        return await searchInObjects(args.search_text, args.object_types, args.case_sensitive);

      case "get_dependencies":
        return await getDependencies(args.object_name, args.direction);

      case "get_table_info":
        return await getTableInfo(args.table_name, {
          include_indexes: args.include_indexes,
          include_foreign_keys: args.include_foreign_keys,
          include_row_count: args.include_row_count,
        });

      case "validate_sql":
        return await validateSql(args.query);

      // ========================================
      // NEW SQL SERVER TOOLS - WITH BACKUP
      // ========================================
      case "alter_procedure":
        return await alterProcedure(args.procedure_name, args.new_definition, args.confirm);

      case "alter_function":
        return await alterFunction(args.function_name, args.new_definition, args.confirm);

      case "alter_view":
        return await alterView(args.view_name, args.new_definition, args.confirm);

      case "drop_object":
        return await dropObject(args.object_name, args.object_type, args.confirm);

      case "create_procedure":
        return await createProcedure(args.procedure_name, args.definition, args.confirm);

      case "create_function":
        return await createFunction(args.function_name, args.definition, args.confirm);

      case "create_view":
        return await createView(args.view_name, args.definition, args.confirm);

      // ========================================
      // NEW SQL SERVER TOOLS - EXECUTION
      // ========================================
      case "exec_procedure":
        return await execProcedure(
          args.procedure_name,
          args.parameters,
          args.confirm,
          args.timeout_seconds,
          args.max_rows
        );

      case "get_procedure_info":
        return await getProcedureInfo(args.procedure_name);

      // ========================================
      // NEW SQL SERVER TOOLS - BACKUP MANAGEMENT
      // ========================================
      case "list_backups":
        return await listBackups(args.object_name, args.object_type, args.limit);

      case "restore_from_backup":
        return await restoreFromBackup(args.backup_id, args.confirm);

      case "diff_backups":
        return await diffBackups(args.backup_id_old, args.backup_id_new);

      case "get_backup":
        return await getBackup(args.backup_id);

      case "get_backup_statistics":
        return await getBackupStatistics();

      case "cleanup_backups":
        return await cleanupBackups(args.days, args.confirm);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return formatErrorResponse(error);
  }
}
