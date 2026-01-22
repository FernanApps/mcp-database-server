/**
 * Table Tools for MCP SQL Server
 * Tools for managing tables with automatic backup of structure
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll, dbExec, getDatabaseType, getDatabaseMetadata } from '../db/index.js';
import { createBackup } from '../backup/backupManager.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Generate CREATE TABLE script for a table
 * This captures the complete table structure including columns, constraints, indexes
 */
export async function generateCreateTableScript(tableName: string, schemaName: string = 'dbo'): Promise<string> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'Table structure generation is only supported for SQL Server'
    );
  }

  // Get table info
  const tableQuery = `
    SELECT
      t.object_id,
      t.name AS table_name,
      SCHEMA_NAME(t.schema_id) AS schema_name
    FROM sys.tables t
    WHERE t.name = '${tableName.replace(/'/g, "''")}'
      AND SCHEMA_NAME(t.schema_id) = '${schemaName.replace(/'/g, "''")}'
  `;

  const tableResult = await dbAll(tableQuery);
  if (tableResult.length === 0) {
    throw new McpSqlServerError(
      'OBJECT_NOT_FOUND',
      `Table '${schemaName}.${tableName}' not found`,
      { object_name: tableName, object_type: 'TABLE' }
    );
  }

  const objectId = tableResult[0].object_id;

  // Get columns with their definitions
  const columnsQuery = `
    SELECT
      c.name AS column_name,
      t.name AS type_name,
      c.max_length,
      c.precision,
      c.scale,
      c.is_nullable,
      c.is_identity,
      ic.seed_value,
      ic.increment_value,
      dc.definition AS default_value,
      dc.name AS default_constraint_name,
      c.column_id
    FROM sys.columns c
    INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
    LEFT JOIN sys.identity_columns ic ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
    WHERE c.object_id = ${objectId}
    ORDER BY c.column_id
  `;

  const columns = await dbAll(columnsQuery);

  // Get primary key
  const pkQuery = `
    SELECT
      kc.name AS constraint_name,
      STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
    FROM sys.key_constraints kc
    INNER JOIN sys.index_columns ic ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE kc.parent_object_id = ${objectId}
      AND kc.type = 'PK'
    GROUP BY kc.name
  `;

  const pkResult = await dbAll(pkQuery);

  // Get unique constraints
  const uniqueQuery = `
    SELECT
      kc.name AS constraint_name,
      STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
    FROM sys.key_constraints kc
    INNER JOIN sys.index_columns ic ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE kc.parent_object_id = ${objectId}
      AND kc.type = 'UQ'
    GROUP BY kc.name
  `;

  const uniqueResult = await dbAll(uniqueQuery);

  // Get foreign keys
  const fkQuery = `
    SELECT
      fk.name AS constraint_name,
      STRING_AGG(pc.name, ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS columns,
      SCHEMA_NAME(rt.schema_id) AS ref_schema,
      rt.name AS ref_table,
      STRING_AGG(rc.name, ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS ref_columns,
      fk.delete_referential_action_desc AS on_delete,
      fk.update_referential_action_desc AS on_update
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.columns pc ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
    INNER JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
    INNER JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
    WHERE fk.parent_object_id = ${objectId}
    GROUP BY fk.name, rt.schema_id, rt.name, fk.delete_referential_action_desc, fk.update_referential_action_desc
  `;

  const fkResult = await dbAll(fkQuery);

  // Get check constraints
  const checkQuery = `
    SELECT
      cc.name AS constraint_name,
      cc.definition
    FROM sys.check_constraints cc
    WHERE cc.parent_object_id = ${objectId}
  `;

  const checkResult = await dbAll(checkQuery);

  // Get indexes (non-primary, non-unique constraint)
  const indexQuery = `
    SELECT
      i.name AS index_name,
      i.is_unique,
      i.type_desc,
      STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns,
      STRING_AGG(
        CASE WHEN ic.is_included_column = 1 THEN c.name ELSE NULL END,
        ', '
      ) AS included_columns
    FROM sys.indexes i
    INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.object_id = ${objectId}
      AND i.is_primary_key = 0
      AND i.is_unique_constraint = 0
      AND i.type > 0
    GROUP BY i.name, i.is_unique, i.type_desc
  `;

  const indexResult = await dbAll(indexQuery);

  // Build CREATE TABLE script
  let script = `CREATE TABLE [${schemaName}].[${tableName}] (\n`;

  // Columns
  const columnDefs: string[] = [];
  for (const col of columns) {
    let colDef = `    [${col.column_name}] ${formatDataType(col)}`;

    if (col.is_identity) {
      colDef += ` IDENTITY(${col.seed_value || 1},${col.increment_value || 1})`;
    }

    if (!col.is_nullable) {
      colDef += ' NOT NULL';
    } else {
      colDef += ' NULL';
    }

    if (col.default_value) {
      colDef += ` CONSTRAINT [${col.default_constraint_name}] DEFAULT ${col.default_value}`;
    }

    columnDefs.push(colDef);
  }

  // Primary key
  if (pkResult.length > 0) {
    columnDefs.push(`    CONSTRAINT [${pkResult[0].constraint_name}] PRIMARY KEY (${pkResult[0].columns})`);
  }

  // Unique constraints
  for (const uq of uniqueResult) {
    columnDefs.push(`    CONSTRAINT [${uq.constraint_name}] UNIQUE (${uq.columns})`);
  }

  // Foreign keys
  for (const fk of fkResult) {
    let fkDef = `    CONSTRAINT [${fk.constraint_name}] FOREIGN KEY (${fk.columns}) REFERENCES [${fk.ref_schema}].[${fk.ref_table}] (${fk.ref_columns})`;
    if (fk.on_delete && fk.on_delete !== 'NO_ACTION') {
      fkDef += ` ON DELETE ${fk.on_delete.replace('_', ' ')}`;
    }
    if (fk.on_update && fk.on_update !== 'NO_ACTION') {
      fkDef += ` ON UPDATE ${fk.on_update.replace('_', ' ')}`;
    }
    columnDefs.push(fkDef);
  }

  // Check constraints
  for (const chk of checkResult) {
    columnDefs.push(`    CONSTRAINT [${chk.constraint_name}] CHECK ${chk.definition}`);
  }

  script += columnDefs.join(',\n');
  script += '\n);\n';

  // Add indexes
  for (const idx of indexResult) {
    if (idx.index_name) {
      const uniqueStr = idx.is_unique ? 'UNIQUE ' : '';
      script += `\nCREATE ${uniqueStr}${idx.type_desc.replace('_', '')} INDEX [${idx.index_name}] ON [${schemaName}].[${tableName}] (${idx.columns})`;
      if (idx.included_columns) {
        script += ` INCLUDE (${idx.included_columns})`;
      }
      script += ';\n';
    }
  }

  return script;
}

/**
 * Format SQL Server data type from column info
 */
function formatDataType(col: any): string {
  const typeName = col.type_name.toLowerCase();

  // Types without length/precision
  const noLengthTypes = ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'money', 'smallmoney',
                         'float', 'real', 'date', 'datetime', 'datetime2', 'smalldatetime',
                         'time', 'timestamp', 'uniqueidentifier', 'xml', 'text', 'ntext', 'image'];

  if (noLengthTypes.includes(typeName)) {
    return `[${typeName}]`;
  }

  // Decimal/numeric with precision and scale
  if (typeName === 'decimal' || typeName === 'numeric') {
    return `[${typeName}](${col.precision}, ${col.scale})`;
  }

  // Variable length types
  if (typeName === 'varchar' || typeName === 'char' || typeName === 'varbinary' || typeName === 'binary') {
    const length = col.max_length === -1 ? 'MAX' : col.max_length;
    return `[${typeName}](${length})`;
  }

  // Unicode variable length (length is stored as bytes, so divide by 2)
  if (typeName === 'nvarchar' || typeName === 'nchar') {
    const length = col.max_length === -1 ? 'MAX' : Math.floor(col.max_length / 2);
    return `[${typeName}](${length})`;
  }

  // Default: just the type name
  return `[${typeName}]`;
}

/**
 * Get table structure backup for a table
 */
export async function getTableStructure(tableName: string, schemaName: string = 'dbo'): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'get_table_structure is only supported for SQL Server'
    );
  }

  try {
    const script = await generateCreateTableScript(tableName, schemaName);
    return formatSuccessResponse({
      table_name: tableName,
      schema_name: schemaName,
      create_script: script,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting table structure: ${(error as Error).message}`,
      { object_name: tableName }
    );
  }
}

/**
 * Alter table with automatic backup
 */
export async function alterTable(
  tableName: string,
  alterStatement: string,
  schemaName: string = 'dbo'
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'alter_table is only supported for SQL Server'
    );
  }

  if (!tableName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Table name is required'
    );
  }

  if (!alterStatement) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'ALTER statement is required'
    );
  }

  try {
    // Get current table structure for backup
    const currentStructure = await generateCreateTableScript(tableName, schemaName);

    // Create backup before modification
    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      tableName,
      'TABLE',
      schemaName,
      currentStructure,
      'ALTER',
      metadata?.database || 'unknown'
    );

    // Build full ALTER statement if not provided
    let fullStatement = alterStatement.trim();
    if (!fullStatement.toUpperCase().startsWith('ALTER')) {
      fullStatement = `ALTER TABLE [${schemaName}].[${tableName}] ${alterStatement}`;
    }

    // Execute the ALTER
    await dbExec(fullStatement);

    return formatSuccessResponse({
      success: true,
      message: `Table '${schemaName}.${tableName}' altered successfully`,
      backup: backupResult.success ? {
        backup_id: backupResult.backup_id,
        backup_file: backupResult.backup_file,
      } : null,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error altering table: ${(error as Error).message}`,
      { object_name: tableName }
    );
  }
}

/**
 * Drop table with automatic backup
 */
export async function dropTable(
  tableName: string,
  schemaName: string = 'dbo',
  confirm: boolean = false
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'drop_table is only supported for SQL Server'
    );
  }

  if (!tableName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Table name is required'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      `Are you sure you want to DROP table '${schemaName}.${tableName}'? This will DELETE ALL DATA. Set confirm=true to proceed.`,
      { suggestion: 'WARNING: All data in this table will be permanently deleted!' }
    );
  }

  try {
    // Get current table structure for backup
    const currentStructure = await generateCreateTableScript(tableName, schemaName);

    // Create backup before deletion
    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      tableName,
      'TABLE',
      schemaName,
      currentStructure,
      'DROP',
      metadata?.database || 'unknown'
    );

    // Execute DROP
    await dbExec(`DROP TABLE [${schemaName}].[${tableName}]`);

    return formatSuccessResponse({
      success: true,
      message: `Table '${schemaName}.${tableName}' dropped successfully. Structure backup created.`,
      backup: backupResult.success ? {
        backup_id: backupResult.backup_id,
        backup_file: backupResult.backup_file,
      } : null,
      warning: 'Table data was NOT backed up, only the structure.',
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error dropping table: ${(error as Error).message}`,
      { object_name: tableName }
    );
  }
}

/**
 * Truncate table with automatic backup
 */
export async function truncateTable(
  tableName: string,
  schemaName: string = 'dbo',
  confirm: boolean = false
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'truncate_table is only supported for SQL Server'
    );
  }

  if (!tableName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Table name is required'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      `Are you sure you want to TRUNCATE table '${schemaName}.${tableName}'? This will DELETE ALL DATA. Set confirm=true to proceed.`,
      { suggestion: 'WARNING: All data in this table will be permanently deleted!' }
    );
  }

  try {
    // Get current table structure for backup (even though TRUNCATE doesn't change structure)
    const currentStructure = await generateCreateTableScript(tableName, schemaName);

    // Create backup before truncation
    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      tableName,
      'TABLE',
      schemaName,
      currentStructure,
      'ALTER', // Use ALTER since TRUNCATE is a data operation
      metadata?.database || 'unknown'
    );

    // Execute TRUNCATE
    await dbExec(`TRUNCATE TABLE [${schemaName}].[${tableName}]`);

    return formatSuccessResponse({
      success: true,
      message: `Table '${schemaName}.${tableName}' truncated successfully. Structure backup created.`,
      backup: backupResult.success ? {
        backup_id: backupResult.backup_id,
        backup_file: backupResult.backup_file,
      } : null,
      warning: 'Table data was NOT backed up, only the structure. All rows have been deleted.',
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error truncating table: ${(error as Error).message}`,
      { object_name: tableName }
    );
  }
}
