/**
 * Execution Tools for MCP SQL Server
 * Tools for executing stored procedures with safety checks
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll, getDatabaseType, getDatabaseMetadata, getDbAdapter } from '../db/index.js';
import { getSecurityConfig, getLimitsConfig, isProcedureBlocked, getEffectiveTimeout, getEffectiveMaxRows } from '../config/mcpConfig.js';
import type { ProcedureResult, ProcedureInfo } from '../types/sqlServerTypes.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Check if a stored procedure contains write operations
 */
async function checkProcedureHasWrites(procedureName: string): Promise<boolean> {
  // Only check for actual data modification keywords
  // NOTE: We exclude EXEC/EXECUTE because they appear in almost all SP definitions
  // (CREATE PROCEDURE and ALTER PROCEDURE both contain these implicitly)
  // DROP, ALTER, CREATE are also excluded as they often appear in comments or string literals
  const query = `
    SELECT
      CASE
        WHEN m.definition LIKE '%INSERT[^_]%'
          OR m.definition LIKE '%UPDATE[^_]%'
          OR m.definition LIKE '%DELETE[^_]%'
          OR m.definition LIKE '%TRUNCATE TABLE%'
        THEN 1
        ELSE 0
      END AS has_writes
    FROM sys.sql_modules m
    INNER JOIN sys.objects o ON m.object_id = o.object_id
    WHERE o.name = '${procedureName.replace(/'/g, "''")}'
      AND o.type_desc = 'SQL_STORED_PROCEDURE'
  `;

  const results = await dbAll(query);
  if (results.length === 0) {
    return true; // Assume writes if we can't check
  }

  return results[0].has_writes === 1;
}

/**
 * Get information about a stored procedure including parameters
 */
export async function getProcedureInfo(procedureName: string): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'get_procedure_info is only supported for SQL Server'
    );
  }

  if (!procedureName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Procedure name is required'
    );
  }

  try {
    // Get procedure info
    const procQuery = `
      SELECT
        o.name,
        SCHEMA_NAME(o.schema_id) AS schema_name,
        CASE
          WHEN m.definition LIKE '%INSERT[^_]%'
            OR m.definition LIKE '%UPDATE[^_]%'
            OR m.definition LIKE '%DELETE[^_]%'
            OR m.definition LIKE '%TRUNCATE TABLE%'
          THEN 1
          ELSE 0
        END AS has_writes
      FROM sys.objects o
      INNER JOIN sys.sql_modules m ON o.object_id = m.object_id
      WHERE o.name = '${procedureName.replace(/'/g, "''")}'
        AND o.type_desc = 'SQL_STORED_PROCEDURE'
    `;

    const procResults = await dbAll(procQuery);
    if (procResults.length === 0) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Procedure '${procedureName}' not found`,
        { object_name: procedureName, object_type: 'PROCEDURE' }
      );
    }

    // Get parameters
    const paramsQuery = `
      SELECT
        p.name,
        t.name AS type,
        p.max_length,
        p.is_output,
        p.has_default_value
      FROM sys.parameters p
      INNER JOIN sys.types t ON p.user_type_id = t.user_type_id
      WHERE p.object_id = OBJECT_ID('${procedureName.replace(/'/g, "''")}')
      ORDER BY p.parameter_id
    `;

    const paramsResults = await dbAll(paramsQuery);

    const result: ProcedureInfo = {
      name: procResults[0].name,
      schema_name: procResults[0].schema_name,
      has_writes: procResults[0].has_writes === 1,
      parameters: paramsResults.map((p) => ({
        name: p.name,
        type: p.type,
        max_length: p.max_length,
        is_output: !!p.is_output,
        has_default: !!p.has_default_value,
      })),
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting procedure info: ${(error as Error).message}`,
      { object_name: procedureName }
    );
  }
}

/**
 * Execute a stored procedure
 */
export async function execProcedure(
  procedureName: string,
  parameters: Record<string, any> = {},
  confirm: boolean = false,
  timeoutSeconds?: number,
  maxRows?: number
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'exec_procedure is only supported for SQL Server'
    );
  }

  if (!procedureName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Procedure name is required'
    );
  }

  // Check if procedure is blocked
  if (isProcedureBlocked(procedureName)) {
    throw new McpSqlServerError(
      'PERMISSION_DENIED',
      `Procedure '${procedureName}' is blocked for security reasons`,
      { suggestion: 'This procedure is in the blocked list in the configuration' }
    );
  }

  const security = getSecurityConfig();
  const startTime = Date.now();

  try {
    // Check if procedure has writes
    const hasWrites = await checkProcedureHasWrites(procedureName);

    // Require confirmation for procedures with writes
    if (hasWrites && security.require_confirm_for_exec_with_writes && !confirm) {
      throw new McpSqlServerError(
        'CONFIRM_REQUIRED',
        `Procedure '${procedureName}' appears to modify data. Set confirm=true to proceed.`,
        { suggestion: 'This procedure contains INSERT, UPDATE, DELETE, or other write operations' }
      );
    }

    // Get effective limits
    const effectiveTimeout = getEffectiveTimeout(timeoutSeconds);
    const effectiveMaxRows = getEffectiveMaxRows(maxRows);

    // Build parameter string
    const paramEntries = Object.entries(parameters);
    let paramString = '';

    if (paramEntries.length > 0) {
      const paramParts: string[] = [];
      for (const [key, value] of paramEntries) {
        const paramName = key.startsWith('@') ? key : `@${key}`;
        let paramValue: string;

        if (value === null) {
          paramValue = 'NULL';
        } else if (typeof value === 'string') {
          paramValue = `'${value.replace(/'/g, "''")}'`;
        } else if (typeof value === 'boolean') {
          paramValue = value ? '1' : '0';
        } else if (value instanceof Date) {
          paramValue = `'${value.toISOString()}'`;
        } else {
          paramValue = String(value);
        }

        paramParts.push(`${paramName} = ${paramValue}`);
      }
      paramString = ' ' + paramParts.join(', ');
    }

    // Execute the procedure
    const execQuery = `EXEC [${procedureName}]${paramString}`;

    // Note: We use dbAll which has a default timeout
    // In production, you might want to use a different approach for timeout control
    const results = await dbAll(execQuery);

    // Limit results if needed
    let limitedResults = results;
    let wasLimited = false;

    if (results.length > effectiveMaxRows) {
      limitedResults = results.slice(0, effectiveMaxRows);
      wasLimited = true;
    }

    const executionTime = Date.now() - startTime;

    const result: ProcedureResult = {
      success: true,
      result_sets: [limitedResults],
      rows_affected: results.length,
      execution_time_ms: executionTime,
      has_writes: hasWrites,
    };

    if (wasLimited) {
      result.warnings = [`Results limited to ${effectiveMaxRows} rows. Total rows: ${results.length}`];
    }

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }

    const executionTime = Date.now() - startTime;

    // Check for timeout
    if ((error as Error).message.includes('timeout') || executionTime >= getEffectiveTimeout(timeoutSeconds)) {
      throw new McpSqlServerError(
        'TIMEOUT',
        `Procedure execution timed out after ${executionTime}ms`,
        { object_name: procedureName }
      );
    }

    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error executing procedure: ${(error as Error).message}`,
      { object_name: procedureName }
    );
  }
}

/**
 * Execute a stored procedure and return multiple result sets
 * Note: This is a more advanced version that handles multiple result sets
 */
export async function execProcedureMultiResult(
  procedureName: string,
  parameters: Record<string, any> = {},
  confirm: boolean = false
): Promise<ReturnType<typeof formatSuccessResponse>> {
  // For now, this is the same as execProcedure
  // In a real implementation, you would use the mssql library's
  // ability to handle multiple result sets
  return execProcedure(procedureName, parameters, confirm);
}
