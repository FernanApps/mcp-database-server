import { dbAll, dbExec, getListTablesQuery, getDescribeTableQuery, getDatabaseType, getDatabaseMetadata } from '../db/index.js';
import { formatSuccessResponse } from '../utils/formatUtils.js';
import { createBackup } from '../backup/backupManager.js';
import { generateCreateTableScript } from '../tools/tableTools.js';

/**
 * Create a new table in the database
 * @param query CREATE TABLE SQL statement
 * @returns Result of the operation
 */
export async function createTable(query: string) {
  try {
    if (!query.trim().toLowerCase().startsWith("create table")) {
      throw new Error("Only CREATE TABLE statements are allowed");
    }

    await dbExec(query);
    return formatSuccessResponse({ success: true, message: "Table created successfully" });
  } catch (error: any) {
    throw new Error(`SQL Error: ${error.message}`);
  }
}

/**
 * Alter an existing table schema
 * @param query ALTER TABLE SQL statement
 * @returns Result of the operation
 */
export async function alterTable(query: string) {
  try {
    if (!query.trim().toLowerCase().startsWith("alter table")) {
      throw new Error("Only ALTER TABLE statements are allowed");
    }

    // Extract table name from ALTER TABLE statement
    const tableMatch = query.match(/alter\s+table\s+(?:\[?(\w+)\]?\.)?[\["]?(\w+)[\]"]?/i);
    const schemaName = tableMatch?.[1] || 'dbo';
    const tableName = tableMatch?.[2];

    let backupResult = null;

    // Create backup for SQL Server before altering
    if (getDatabaseType() === 'sqlserver' && tableName) {
      try {
        const currentStructure = await generateCreateTableScript(tableName, schemaName);
        const metadata = getDatabaseMetadata();
        backupResult = await createBackup(
          tableName,
          'TABLE',
          schemaName,
          currentStructure,
          'ALTER',
          metadata?.database || 'unknown'
        );
      } catch (backupError) {
        console.error(`[WARN] Could not create backup: ${(backupError as Error).message}`);
      }
    }

    await dbExec(query);

    const result: any = { success: true, message: "Table altered successfully" };
    if (backupResult?.success) {
      result.backup = {
        backup_id: backupResult.backup_id,
        backup_file: backupResult.backup_file,
      };
    }

    return formatSuccessResponse(result);
  } catch (error: any) {
    throw new Error(`SQL Error: ${error.message}`);
  }
}

/**
 * Drop a table from the database
 * @param tableName Name of the table to drop
 * @param confirm Safety confirmation flag
 * @param schemaName Schema name (SQL Server only, defaults to 'dbo')
 * @returns Result of the operation
 */
export async function dropTable(tableName: string, confirm: boolean, schemaName: string = 'dbo') {
  try {
    if (!tableName) {
      throw new Error("Table name is required");
    }

    if (!confirm) {
      return formatSuccessResponse({
        success: false,
        message: "Safety confirmation required. Set confirm=true to proceed with dropping the table."
      });
    }

    // First check if table exists by directly querying for tables
    const query = getListTablesQuery();
    const tables = await dbAll(query);
    const tableNames = tables.map(t => t.name);

    if (!tableNames.includes(tableName)) {
      throw new Error(`Table '${tableName}' does not exist`);
    }

    let backupResult = null;

    // Create backup for SQL Server before dropping
    if (getDatabaseType() === 'sqlserver') {
      try {
        const currentStructure = await generateCreateTableScript(tableName, schemaName);
        const metadata = getDatabaseMetadata();
        backupResult = await createBackup(
          tableName,
          'TABLE',
          schemaName,
          currentStructure,
          'DROP',
          metadata?.database || 'unknown'
        );
      } catch (backupError) {
        console.error(`[WARN] Could not create backup: ${(backupError as Error).message}`);
      }
    }

    // Drop the table (use brackets for SQL Server)
    const dropQuery = getDatabaseType() === 'sqlserver'
      ? `DROP TABLE [${schemaName}].[${tableName}]`
      : `DROP TABLE "${tableName}"`;
    await dbExec(dropQuery);

    const result: any = {
      success: true,
      message: `Table '${tableName}' dropped successfully`
    };

    if (backupResult?.success) {
      result.backup = {
        backup_id: backupResult.backup_id,
        backup_file: backupResult.backup_file,
      };
      result.warning = 'Table data was NOT backed up, only the structure.';
    }

    return formatSuccessResponse(result);
  } catch (error: any) {
    throw new Error(`Error dropping table: ${error.message}`);
  }
}

/**
 * List all tables in the database
 * @returns Array of table names
 */
export async function listTables() {
  try {
    // Use adapter-specific query for listing tables
    const query = getListTablesQuery();
    const tables = await dbAll(query);
    return formatSuccessResponse(tables.map((t) => t.name));
  } catch (error: any) {
    throw new Error(`Error listing tables: ${error.message}`);
  }
}

/**
 * Get schema information for a specific table
 * @param tableName Name of the table to describe
 * @returns Column definitions for the table
 */
export async function describeTable(tableName: string) {
  try {
    if (!tableName) {
      throw new Error("Table name is required");
    }

    // First check if table exists by directly querying for tables
    const query = getListTablesQuery();
    const tables = await dbAll(query);
    const tableNames = tables.map(t => t.name);
    
    if (!tableNames.includes(tableName)) {
      throw new Error(`Table '${tableName}' does not exist`);
    }
    
    // Use adapter-specific query for describing tables
    const descQuery = getDescribeTableQuery(tableName);
    const columns = await dbAll(descQuery);
    
    return formatSuccessResponse(columns.map((col) => ({
      name: col.name,
      type: col.type,
      notnull: !!col.notnull,
      default_value: col.dflt_value,
      primary_key: !!col.pk
    })));
  } catch (error: any) {
    throw new Error(`Error describing table: ${error.message}`);
  }
} 