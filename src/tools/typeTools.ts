/**
 * Type Tools for MCP SQL Server
 * Tools for managing user-defined types (TABLE types, alias types, etc.)
 * All destructive operations include automatic backup before modification
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll, dbExec, getDatabaseType, getDatabaseMetadata } from '../db/index.js';
import { createBackup } from '../backup/backupManager.js';
import { getSecurityConfig } from '../config/mcpConfig.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Get the definition script for a user-defined type
 */
async function getTypeDefinitionInternal(typeName: string, schemaName: string = 'dbo'): Promise<{
  definition: string;
  type_name: string;
  schema_name: string;
  is_table_type: boolean;
} | null> {
  const safeName = typeName.replace(/'/g, "''");
  const safeSchema = schemaName.replace(/'/g, "''");

  // First check if the type exists and what kind it is
  const typeInfo = await dbAll(`
    SELECT
      t.name AS type_name,
      SCHEMA_NAME(t.schema_id) AS schema_name,
      t.is_table_type,
      t.is_user_defined,
      t.system_type_id,
      t.max_length,
      t.precision,
      t.scale,
      t.is_nullable,
      bt.name AS base_type_name
    FROM sys.types t
    LEFT JOIN sys.types bt ON t.system_type_id = bt.user_type_id
    WHERE t.name = '${safeName}'
      AND SCHEMA_NAME(t.schema_id) = '${safeSchema}'
      AND t.is_user_defined = 1
  `);

  if (typeInfo.length === 0) {
    return null;
  }

  const info = typeInfo[0];
  let definition = '';

  if (info.is_table_type) {
    // Generate CREATE TYPE ... AS TABLE script
    const columns = await dbAll(`
      SELECT
        c.name AS column_name,
        tp.name AS type_name,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        c.is_identity,
        ic.seed_value,
        ic.increment_value,
        dc.definition AS default_definition,
        c.column_id
      FROM sys.table_types tt
      INNER JOIN sys.columns c ON c.object_id = tt.type_table_object_id
      INNER JOIN sys.types tp ON c.system_type_id = tp.system_type_id AND c.user_type_id = tp.user_type_id
      LEFT JOIN sys.identity_columns ic ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
      WHERE tt.name = '${safeName}'
        AND SCHEMA_NAME(tt.schema_id) = '${safeSchema}'
      ORDER BY c.column_id
    `);

    // Get primary key columns
    const pkColumns = await dbAll(`
      SELECT
        ic.column_id,
        c.name AS column_name
      FROM sys.table_types tt
      INNER JOIN sys.indexes i ON i.object_id = tt.type_table_object_id AND i.is_primary_key = 1
      INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE tt.name = '${safeName}'
        AND SCHEMA_NAME(tt.schema_id) = '${safeSchema}'
      ORDER BY ic.key_ordinal
    `);

    // Get unique constraints
    const uniqueConstraints = await dbAll(`
      SELECT
        i.name AS index_name,
        c.name AS column_name
      FROM sys.table_types tt
      INNER JOIN sys.indexes i ON i.object_id = tt.type_table_object_id AND i.is_unique = 1 AND i.is_primary_key = 0
      INNER JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE tt.name = '${safeName}'
        AND SCHEMA_NAME(tt.schema_id) = '${safeSchema}'
      ORDER BY i.name, ic.key_ordinal
    `);

    // Build column definitions
    const colDefs = columns.map((col: any) => {
      let colDef = `  [${col.column_name}] ${formatDataType(col.type_name, col.max_length, col.precision, col.scale)}`;
      if (col.is_identity) {
        colDef += ` IDENTITY(${col.seed_value || 1},${col.increment_value || 1})`;
      }
      colDef += col.is_nullable ? ' NULL' : ' NOT NULL';
      if (col.default_definition) {
        colDef += ` DEFAULT ${col.default_definition}`;
      }
      return colDef;
    });

    // Add primary key constraint
    if (pkColumns.length > 0) {
      const pkCols = pkColumns.map((pk: any) => `[${pk.column_name}]`).join(', ');
      colDefs.push(`  PRIMARY KEY (${pkCols})`);
    }

    // Add unique constraints
    const uniqueGroups = new Map<string, string[]>();
    for (const uc of uniqueConstraints) {
      if (!uniqueGroups.has(uc.index_name)) {
        uniqueGroups.set(uc.index_name, []);
      }
      uniqueGroups.get(uc.index_name)!.push(`[${uc.column_name}]`);
    }
    for (const [, cols] of uniqueGroups) {
      colDefs.push(`  UNIQUE (${cols.join(', ')})`);
    }

    definition = `CREATE TYPE [${safeSchema}].[${safeName}] AS TABLE (\n${colDefs.join(',\n')}\n)`;
  } else {
    // Alias type - simple definition
    let baseType = formatDataType(info.base_type_name, info.max_length, info.precision, info.scale);
    const nullable = info.is_nullable ? 'NULL' : 'NOT NULL';
    definition = `CREATE TYPE [${safeSchema}].[${safeName}] FROM ${baseType} ${nullable}`;
  }

  return {
    definition,
    type_name: info.type_name,
    schema_name: info.schema_name,
    is_table_type: info.is_table_type,
  };
}

/**
 * Format SQL data type with length/precision/scale
 */
function formatDataType(typeName: string, maxLength: number, precision: number, scale: number): string {
  const noLengthTypes = ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'money', 'smallmoney',
    'float', 'real', 'date', 'datetime', 'datetime2', 'smalldatetime', 'time',
    'datetimeoffset', 'timestamp', 'uniqueidentifier', 'xml', 'text', 'ntext', 'image',
    'sql_variant', 'hierarchyid', 'geometry', 'geography'];

  if (noLengthTypes.includes(typeName.toLowerCase())) {
    return typeName;
  }

  if (['decimal', 'numeric'].includes(typeName.toLowerCase())) {
    return `${typeName}(${precision},${scale})`;
  }

  if (['nvarchar', 'nchar'].includes(typeName.toLowerCase())) {
    return maxLength === -1 ? `${typeName}(MAX)` : `${typeName}(${maxLength / 2})`;
  }

  if (['varchar', 'char', 'varbinary', 'binary'].includes(typeName.toLowerCase())) {
    return maxLength === -1 ? `${typeName}(MAX)` : `${typeName}(${maxLength})`;
  }

  return typeName;
}

// ============================================================
// PUBLIC TOOLS
// ============================================================

/**
 * List all user-defined types in the database
 */
export async function listTypes(
  schemaName?: string,
  filter?: string
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'list_types is only supported for SQL Server'
    );
  }

  try {
    let query = `
      SELECT
        t.name AS type_name,
        SCHEMA_NAME(t.schema_id) AS schema_name,
        CASE WHEN t.is_table_type = 1 THEN 'TABLE_TYPE' ELSE 'ALIAS_TYPE' END AS type_category,
        bt.name AS base_type_name,
        t.max_length,
        t.precision,
        t.scale,
        t.is_nullable,
        t.is_table_type,
        t.create_date,
        t.modify_date
      FROM sys.types t
      LEFT JOIN sys.types bt ON t.system_type_id = bt.user_type_id
      WHERE t.is_user_defined = 1
    `;

    if (schemaName) {
      query += ` AND SCHEMA_NAME(t.schema_id) = '${schemaName.replace(/'/g, "''")}'`;
    }

    if (filter) {
      query += ` AND t.name LIKE '${filter.replace(/'/g, "''")}'`;
    }

    query += ` ORDER BY SCHEMA_NAME(t.schema_id), t.name`;

    const results = await dbAll(query);

    return formatSuccessResponse({
      total: results.length,
      types: results,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) throw error;
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error listing types: ${(error as Error).message}`
    );
  }
}

/**
 * Get the full definition/structure of a user-defined type
 */
export async function getTypeDefinition(
  typeName: string,
  schemaName: string = 'dbo'
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'get_type_definition is only supported for SQL Server'
    );
  }

  if (!typeName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Type name is required'
    );
  }

  try {
    const typeInfo = await getTypeDefinitionInternal(typeName, schemaName);

    if (!typeInfo) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Type '${schemaName}.${typeName}' not found`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    // If it's a table type, also get column details
    let columns: any[] = [];
    if (typeInfo.is_table_type) {
      columns = await dbAll(`
        SELECT
          c.name AS column_name,
          tp.name AS type_name,
          c.max_length,
          c.precision,
          c.scale,
          c.is_nullable,
          c.is_identity,
          c.column_id
        FROM sys.table_types tt
        INNER JOIN sys.columns c ON c.object_id = tt.type_table_object_id
        INNER JOIN sys.types tp ON c.system_type_id = tp.system_type_id AND c.user_type_id = tp.user_type_id
        WHERE tt.name = '${typeName.replace(/'/g, "''")}'
          AND SCHEMA_NAME(tt.schema_id) = '${schemaName.replace(/'/g, "''")}'
        ORDER BY c.column_id
      `);
    }

    return formatSuccessResponse({
      type_name: typeInfo.type_name,
      schema_name: typeInfo.schema_name,
      is_table_type: typeInfo.is_table_type,
      definition: typeInfo.definition,
      columns: typeInfo.is_table_type ? columns : undefined,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) throw error;
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting type definition: ${(error as Error).message}`,
      { object_name: typeName }
    );
  }
}

/**
 * Create a new user-defined type
 */
export async function createType(
  typeName: string,
  definition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'create_type is only supported for SQL Server'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.'
    );
  }

  if (!typeName || !definition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Type name and definition are required'
    );
  }

  try {
    // Check if type already exists
    const schemaMatch = typeName.match(/^(\w+)\.(\w+)$/);
    const schema = schemaMatch ? schemaMatch[1] : 'dbo';
    const name = schemaMatch ? schemaMatch[2] : typeName;

    const existing = await getTypeDefinitionInternal(name, schema);
    if (existing) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        `Type '${schema}.${name}' already exists. Use drop_type first to recreate it.`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    // Ensure definition starts with CREATE TYPE
    let finalDefinition = definition.trim();
    if (!finalDefinition.toUpperCase().startsWith('CREATE TYPE')) {
      throw new McpSqlServerError(
        'SYNTAX_ERROR',
        'Definition must start with CREATE TYPE',
        { suggestion: 'Provide the complete CREATE TYPE statement' }
      );
    }

    await dbExec(finalDefinition);

    return formatSuccessResponse({
      success: true,
      message: `Type '${typeName}' created successfully`,
      object_name: typeName,
      object_type: 'TYPE',
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) throw error;
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error creating type: ${(error as Error).message}`,
      { object_name: typeName }
    );
  }
}

/**
 * Drop a user-defined type (with backup)
 */
export async function dropType(
  typeName: string,
  schemaName: string = 'dbo',
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'drop_type is only supported for SQL Server'
    );
  }

  const security = getSecurityConfig();

  if (security.require_confirm_for_drop && !confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.',
      { suggestion: 'WARNING: This will permanently delete the type. A backup will be created first.' }
    );
  }

  if (!typeName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Type name is required'
    );
  }

  try {
    // Verify type exists and get its definition
    const typeInfo = await getTypeDefinitionInternal(typeName, schemaName);
    if (!typeInfo) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Type '${schemaName}.${typeName}' not found`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    // Check if type is in use
    const usage = await dbAll(`
      SELECT
        OBJECT_NAME(p.object_id) AS object_name,
        p.name AS parameter_name
      FROM sys.parameters p
      WHERE p.user_type_id = TYPE_ID('${schemaName.replace(/'/g, "''")}.${typeName.replace(/'/g, "''")}')
      UNION ALL
      SELECT
        OBJECT_NAME(c.object_id) AS object_name,
        c.name AS column_name
      FROM sys.columns c
      WHERE c.user_type_id = TYPE_ID('${schemaName.replace(/'/g, "''")}.${typeName.replace(/'/g, "''")}')
        AND OBJECTPROPERTY(c.object_id, 'IsUserTable') = 1
    `);

    if (usage.length > 0) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        `Type '${schemaName}.${typeName}' is in use by: ${usage.map((u: any) => `${u.object_name}.${u.parameter_name}`).join(', ')}. Remove dependencies first.`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    // Create backup before dropping
    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      typeName,
      'TYPE',
      typeInfo.schema_name,
      typeInfo.definition,
      'DROP',
      metadata.database || metadata.name
    );

    if (!backupResult.success) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Failed to create backup: ${backupResult.message}`
      );
    }

    // Drop the type
    await dbExec(`DROP TYPE [${schemaName}].[${typeName}]`);

    return formatSuccessResponse({
      success: true,
      message: `Type '${schemaName}.${typeName}' dropped successfully. Backup created.`,
      backup_file: backupResult.backup_file,
      backup_id: backupResult.backup_id,
      restore_hint: `To recreate, use create_type with the definition from backup_id: '${backupResult.backup_id}'`,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) throw error;
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error dropping type: ${(error as Error).message}`,
      { object_name: typeName, object_type: 'TYPE' }
    );
  }
}

/**
 * Alter (recreate) a user-defined type
 * Note: SQL Server does not support ALTER TYPE for table types.
 * This drops and recreates the type (with backup).
 */
export async function alterType(
  typeName: string,
  newDefinition: string,
  schemaName: string = 'dbo',
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'alter_type is only supported for SQL Server'
    );
  }

  const security = getSecurityConfig();

  if (security.require_confirm_for_alter && !confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.',
      { suggestion: 'This will drop and recreate the type. A backup will be created first.' }
    );
  }

  if (!typeName || !newDefinition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Type name and new definition are required'
    );
  }

  try {
    // Verify type exists
    const typeInfo = await getTypeDefinitionInternal(typeName, schemaName);
    if (!typeInfo) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Type '${schemaName}.${typeName}' not found`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    // Check if type is in use (cannot alter if dependencies exist)
    const usage = await dbAll(`
      SELECT
        OBJECT_NAME(p.object_id) AS object_name,
        p.name AS parameter_name
      FROM sys.parameters p
      WHERE p.user_type_id = TYPE_ID('${schemaName.replace(/'/g, "''")}.${typeName.replace(/'/g, "''")}')
      UNION ALL
      SELECT
        OBJECT_NAME(c.object_id) AS object_name,
        c.name AS column_name
      FROM sys.columns c
      WHERE c.user_type_id = TYPE_ID('${schemaName.replace(/'/g, "''")}.${typeName.replace(/'/g, "''")}')
        AND OBJECTPROPERTY(c.object_id, 'IsUserTable') = 1
    `);

    if (usage.length > 0) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        `Type '${schemaName}.${typeName}' is in use by: ${usage.map((u: any) => `${u.object_name}.${u.parameter_name}`).join(', ')}. Remove dependencies first before altering.`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    // Create backup before modification
    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      typeName,
      'TYPE',
      typeInfo.schema_name,
      typeInfo.definition,
      'ALTER',
      metadata.database || metadata.name
    );

    if (!backupResult.success) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Failed to create backup: ${backupResult.message}`
      );
    }

    // Drop existing type
    await dbExec(`DROP TYPE [${schemaName}].[${typeName}]`);

    // Create with new definition
    let finalDefinition = newDefinition.trim();
    if (!finalDefinition.toUpperCase().startsWith('CREATE TYPE')) {
      throw new McpSqlServerError(
        'SYNTAX_ERROR',
        'New definition must start with CREATE TYPE',
        { suggestion: 'Provide the complete CREATE TYPE statement' }
      );
    }

    try {
      await dbExec(finalDefinition);
    } catch (createError) {
      // If creation fails, try to restore the original
      try {
        await dbExec(typeInfo.definition);
      } catch (restoreError) {
        throw new McpSqlServerError(
          'INVALID_OPERATION',
          `CRITICAL: Failed to create new type AND failed to restore original. Use backup_id '${backupResult.backup_id}' to manually restore. Create error: ${(createError as Error).message}`,
          { object_name: typeName, object_type: 'TYPE' }
        );
      }
      throw new McpSqlServerError(
        'SYNTAX_ERROR',
        `Failed to create new type definition (original restored): ${(createError as Error).message}`,
        { object_name: typeName, object_type: 'TYPE' }
      );
    }

    return formatSuccessResponse({
      success: true,
      message: `Type '${schemaName}.${typeName}' altered successfully (drop + recreate)`,
      backup_file: backupResult.backup_file,
      backup_id: backupResult.backup_id,
      object_name: typeName,
      object_type: 'TYPE',
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) throw error;
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error altering type: ${(error as Error).message}`,
      { object_name: typeName, object_type: 'TYPE' }
    );
  }
}
