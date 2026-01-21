/**
 * Object Tools for MCP SQL Server
 * Tools for getting object definitions, listing objects, and searching in objects
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll } from '../db/index.js';
import { getDatabaseType } from '../db/index.js';
import type { ObjectDefinition, DbObject, SearchMatch, SqlObjectType } from '../types/sqlServerTypes.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Map user-friendly object type to SQL Server type_desc values
 */
function mapObjectType(objectType?: SqlObjectType): string[] {
  if (!objectType || objectType === 'ALL') {
    return ['SQL_STORED_PROCEDURE', 'SQL_SCALAR_FUNCTION', 'SQL_TABLE_VALUED_FUNCTION',
            'SQL_INLINE_TABLE_VALUED_FUNCTION', 'VIEW', 'SQL_TRIGGER'];
  }

  const typeMap: Record<string, string[]> = {
    'PROCEDURE': ['SQL_STORED_PROCEDURE'],
    'FUNCTION': ['SQL_SCALAR_FUNCTION', 'SQL_TABLE_VALUED_FUNCTION', 'SQL_INLINE_TABLE_VALUED_FUNCTION'],
    'VIEW': ['VIEW'],
    'TRIGGER': ['SQL_TRIGGER'],
  };

  return typeMap[objectType.toUpperCase()] || [];
}

/**
 * Get the definition of a database object (procedure, function, view, trigger)
 */
export async function getObjectDefinition(
  objectName: string,
  objectType?: SqlObjectType
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'get_object_definition is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  if (!objectName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Object name is required',
      { suggestion: 'Provide the name of the procedure, function, view, or trigger' }
    );
  }

  try {
    const typeFilter = objectType ? mapObjectType(objectType) : null;
    let query = `
      SELECT
        o.name AS object_name,
        o.type_desc AS object_type,
        SCHEMA_NAME(o.schema_id) AS schema_name,
        m.definition,
        CONVERT(VARCHAR(23), o.create_date, 121) AS created_date,
        CONVERT(VARCHAR(23), o.modify_date, 121) AS modified_date
      FROM sys.objects o
      INNER JOIN sys.sql_modules m ON o.object_id = m.object_id
      WHERE o.name = '${objectName.replace(/'/g, "''")}'
    `;

    if (typeFilter && typeFilter.length > 0) {
      query += ` AND o.type_desc IN (${typeFilter.map(t => `'${t}'`).join(', ')})`;
    }

    const results = await dbAll(query);

    if (results.length === 0) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Object '${objectName}' not found`,
        { object_name: objectName, object_type: objectType }
      );
    }

    const result: ObjectDefinition = {
      object_name: results[0].object_name,
      object_type: results[0].object_type,
      schema_name: results[0].schema_name,
      definition: results[0].definition,
      created_date: results[0].created_date,
      modified_date: results[0].modified_date,
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting object definition: ${(error as Error).message}`,
      { object_name: objectName }
    );
  }
}

/**
 * List database objects by type
 */
export async function listObjects(
  objectType: SqlObjectType = 'ALL',
  schema: string = 'dbo',
  filter?: string
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'list_objects is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  try {
    const typeFilter = mapObjectType(objectType);

    let query = `
      SELECT
        o.name,
        o.type_desc AS type,
        SCHEMA_NAME(o.schema_id) AS schema_name,
        CONVERT(VARCHAR(23), o.create_date, 121) AS created_date,
        CONVERT(VARCHAR(23), o.modify_date, 121) AS modified_date
      FROM sys.objects o
      WHERE o.type_desc IN (${typeFilter.map(t => `'${t}'`).join(', ')})
        AND SCHEMA_NAME(o.schema_id) = '${schema.replace(/'/g, "''")}'
    `;

    if (filter) {
      query += ` AND o.name LIKE '%${filter.replace(/'/g, "''")}%'`;
    }

    query += ' ORDER BY o.name';

    const results = await dbAll(query);

    const objects: DbObject[] = results.map((row) => ({
      name: row.name,
      type: row.type,
      schema_name: row.schema_name,
      created_date: row.created_date,
      modified_date: row.modified_date,
    }));

    return formatSuccessResponse({
      count: objects.length,
      schema,
      object_type: objectType,
      objects,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error listing objects: ${(error as Error).message}`
    );
  }
}

/**
 * Search for text within database object definitions
 */
export async function searchInObjects(
  searchText: string,
  objectTypes?: SqlObjectType[],
  caseSensitive: boolean = false
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'search_in_objects is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  if (!searchText) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Search text is required',
      { suggestion: 'Provide text to search for in object definitions' }
    );
  }

  try {
    // Build type filter
    let typeFilter: string[] = [];
    if (objectTypes && objectTypes.length > 0) {
      for (const ot of objectTypes) {
        typeFilter = typeFilter.concat(mapObjectType(ot));
      }
    } else {
      typeFilter = mapObjectType('ALL');
    }

    const collation = caseSensitive ? 'COLLATE Latin1_General_BIN' : '';
    const escapedSearch = searchText.replace(/'/g, "''");

    const query = `
      SELECT
        o.name AS object_name,
        o.type_desc AS object_type,
        SCHEMA_NAME(o.schema_id) AS schema_name,
        m.definition
      FROM sys.objects o
      INNER JOIN sys.sql_modules m ON o.object_id = m.object_id
      WHERE o.type_desc IN (${typeFilter.map(t => `'${t}'`).join(', ')})
        AND m.definition ${collation} LIKE '%${escapedSearch}%'
      ORDER BY o.name
    `;

    const results = await dbAll(query);

    // Process results to find line numbers
    const matches: SearchMatch[] = [];

    for (const row of results) {
      const lines = (row.definition || '').split('\n');
      const searchLower = caseSensitive ? searchText : searchText.toLowerCase();

      lines.forEach((line: string, index: number) => {
        const lineToSearch = caseSensitive ? line : line.toLowerCase();
        if (lineToSearch.includes(searchLower)) {
          matches.push({
            object_name: row.object_name,
            object_type: row.object_type,
            line_number: index + 1,
            line_content: line.trim().substring(0, 200), // Limit line length
          });
        }
      });
    }

    return formatSuccessResponse({
      search_text: searchText,
      case_sensitive: caseSensitive,
      total_matches: matches.length,
      objects_found: results.length,
      matches,
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error searching in objects: ${(error as Error).message}`
    );
  }
}
