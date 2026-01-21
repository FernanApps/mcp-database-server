/**
 * Dependency Tools for MCP SQL Server
 * Tools for getting object dependencies and extended table information
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll } from '../db/index.js';
import { getDatabaseType } from '../db/index.js';
import type {
  Dependencies,
  DependencyObject,
  ExtendedTableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  ReferencedByInfo,
  TableInfoOptions,
} from '../types/sqlServerTypes.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Get dependencies for a database object
 */
export async function getDependencies(
  objectName: string,
  direction: 'uses' | 'used_by' | 'both' = 'both'
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'get_dependencies is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  if (!objectName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Object name is required',
      { suggestion: 'Provide the name of the object to get dependencies for' }
    );
  }

  try {
    const result: Dependencies = {
      object_name: objectName,
      uses: [],
      used_by: [],
    };

    // Get objects that this object references (uses)
    if (direction === 'uses' || direction === 'both') {
      const usesQuery = `
        SELECT DISTINCT
          COALESCE(OBJECT_NAME(d.referenced_id), d.referenced_entity_name) AS name,
          COALESCE(o.type_desc, d.referenced_class_desc) AS type,
          COALESCE(SCHEMA_NAME(o.schema_id), d.referenced_schema_name) AS schema_name
        FROM sys.sql_expression_dependencies d
        LEFT JOIN sys.objects o ON d.referenced_id = o.object_id
        WHERE d.referencing_id = OBJECT_ID('${objectName.replace(/'/g, "''")}')
          AND d.referenced_id IS NOT NULL
        ORDER BY name
      `;

      const usesResults = await dbAll(usesQuery);
      result.uses = usesResults.map((row) => ({
        name: row.name,
        type: row.type,
        schema_name: row.schema_name,
      }));
    }

    // Get objects that reference this object (used_by)
    if (direction === 'used_by' || direction === 'both') {
      const usedByQuery = `
        SELECT DISTINCT
          OBJECT_NAME(d.referencing_id) AS name,
          o.type_desc AS type,
          SCHEMA_NAME(o.schema_id) AS schema_name
        FROM sys.sql_expression_dependencies d
        INNER JOIN sys.objects o ON d.referencing_id = o.object_id
        WHERE d.referenced_id = OBJECT_ID('${objectName.replace(/'/g, "''")}')
        ORDER BY name
      `;

      const usedByResults = await dbAll(usedByQuery);
      result.used_by = usedByResults.map((row) => ({
        name: row.name,
        type: row.type,
        schema_name: row.schema_name,
      }));
    }

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting dependencies: ${(error as Error).message}`,
      { object_name: objectName }
    );
  }
}

/**
 * Get extended table information
 */
export async function getTableInfo(
  tableName: string,
  options: TableInfoOptions = {}
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'get_table_info is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  if (!tableName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Table name is required',
      { suggestion: 'Provide the name of the table to get information for' }
    );
  }

  const {
    include_indexes = true,
    include_foreign_keys = true,
    include_row_count = false,
  } = options;

  try {
    // Verify table exists
    const tableExistsQuery = `
      SELECT
        t.name AS table_name,
        SCHEMA_NAME(t.schema_id) AS schema_name
      FROM sys.tables t
      WHERE t.name = '${tableName.replace(/'/g, "''")}'
    `;

    const tableExists = await dbAll(tableExistsQuery);
    if (tableExists.length === 0) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Table '${tableName}' not found`,
        { object_name: tableName, object_type: 'TABLE' }
      );
    }

    const result: ExtendedTableInfo = {
      table_name: tableExists[0].table_name,
      schema_name: tableExists[0].schema_name,
      columns: [],
    };

    // Get columns
    const columnsQuery = `
      SELECT
        c.name,
        t.name AS data_type,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
        c.is_identity,
        c.is_computed,
        dc.definition AS default_value
      FROM sys.columns c
      INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        INNER JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.is_primary_key = 1
      ) pk ON c.object_id = pk.object_id AND c.column_id = pk.column_id
      LEFT JOIN sys.default_constraints dc ON c.default_object_id = dc.object_id
      WHERE c.object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
      ORDER BY c.column_id
    `;

    const columnsResults = await dbAll(columnsQuery);
    result.columns = columnsResults.map((row) => ({
      name: row.name,
      data_type: row.data_type,
      max_length: row.max_length,
      precision: row.precision,
      scale: row.scale,
      is_nullable: !!row.is_nullable,
      is_primary_key: !!row.is_primary_key,
      is_identity: !!row.is_identity,
      is_computed: !!row.is_computed,
      default_value: row.default_value,
    }));

    // Get indexes
    if (include_indexes) {
      const indexesQuery = `
        SELECT
          i.name AS index_name,
          i.type_desc AS index_type,
          i.is_unique,
          i.is_primary_key,
          STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
        FROM sys.indexes i
        INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        WHERE i.object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
          AND i.name IS NOT NULL
        GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
        ORDER BY i.name
      `;

      const indexesResults = await dbAll(indexesQuery);
      result.indexes = indexesResults.map((row) => ({
        name: row.index_name,
        type: row.index_type,
        columns: row.columns ? row.columns.split(', ') : [],
        is_unique: !!row.is_unique,
        is_primary_key: !!row.is_primary_key,
      }));
    }

    // Get foreign keys
    if (include_foreign_keys) {
      const fkQuery = `
        SELECT
          fk.name AS fk_name,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
          OBJECT_NAME(fkc.referenced_object_id) AS references_table,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS references_column,
          fk.delete_referential_action_desc AS on_delete,
          fk.update_referential_action_desc AS on_update
        FROM sys.foreign_keys fk
        INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        WHERE fk.parent_object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
        ORDER BY fk.name
      `;

      const fkResults = await dbAll(fkQuery);
      result.foreign_keys = fkResults.map((row) => ({
        name: row.fk_name,
        column: row.column_name,
        references_table: row.references_table,
        references_column: row.references_column,
        on_delete: row.on_delete,
        on_update: row.on_update,
      }));

      // Get tables that reference this table
      const refByQuery = `
        SELECT
          OBJECT_NAME(fk.parent_object_id) AS table_name,
          fk.name AS fk_name,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name
        FROM sys.foreign_keys fk
        INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        WHERE fk.referenced_object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
        ORDER BY table_name
      `;

      const refByResults = await dbAll(refByQuery);
      result.referenced_by = refByResults.map((row) => ({
        table_name: row.table_name,
        fk_name: row.fk_name,
        column: row.column_name,
      }));
    }

    // Get row count (optional, can be slow for large tables)
    if (include_row_count) {
      const rowCountQuery = `
        SELECT SUM(p.rows) AS row_count
        FROM sys.partitions p
        WHERE p.object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
          AND p.index_id IN (0, 1)
      `;

      const rowCountResult = await dbAll(rowCountQuery);
      result.row_count = rowCountResult[0]?.row_count || 0;
    }

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting table info: ${(error as Error).message}`,
      { object_name: tableName }
    );
  }
}
