/**
 * Validation Tools for MCP SQL Server
 * Tools for validating SQL syntax without execution
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll, dbExec } from '../db/index.js';
import { getDatabaseType, getDbAdapter } from '../db/index.js';
import type { ValidationResult, SqlValidationError } from '../types/sqlServerTypes.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Validate SQL syntax without executing
 */
export async function validateSql(query: string): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'validate_sql is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  if (!query || !query.trim()) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Query is required for validation',
      { suggestion: 'Provide a SQL query to validate' }
    );
  }

  // Use SET NOEXEC ON directly - it parses and compiles but doesn't execute
  // This is more reliable than SET PARSEONLY with TRY-CATCH
  try {
    // First, set NOEXEC ON
    await dbExec('SET NOEXEC ON');

    let isValid = true;
    let errorMessage = '';
    let errorLine = 0;
    let errorNumber: number | undefined;

    try {
      await dbExec(query);
    } catch (execError) {
      isValid = false;
      errorMessage = (execError as Error).message;

      // Try to extract line number from error message
      const lineMatch = errorMessage.match(/Line (\d+)/i);
      if (lineMatch) {
        errorLine = parseInt(lineMatch[1], 10);
      }

      // Try to extract error number
      const errorNumMatch = errorMessage.match(/Msg (\d+)/i);
      if (errorNumMatch) {
        errorNumber = parseInt(errorNumMatch[1], 10);
      }
    }

    // Always turn NOEXEC back off
    await dbExec('SET NOEXEC OFF');

    if (isValid) {
      const result: ValidationResult = {
        is_valid: true,
      };
      return formatSuccessResponse(result);
    } else {
      const errors: SqlValidationError[] = [
        {
          message: errorMessage,
          line: errorLine,
          position: 0,
          error_number: errorNumber,
        },
      ];

      const result: ValidationResult = {
        is_valid: false,
        errors,
      };
      return formatSuccessResponse(result);
    }
  } catch (error) {
    // Ensure NOEXEC is off even if something goes wrong
    try {
      await dbExec('SET NOEXEC OFF');
    } catch {
      // Ignore error turning off NOEXEC
    }

    // Report the error
    const result: ValidationResult = {
      is_valid: false,
      errors: [
        {
          message: (error as Error).message,
          line: 0,
          position: 0,
        },
      ],
    };
    return formatSuccessResponse(result);
  }
}

/**
 * Simple validation using SET NOEXEC
 */
async function validateSqlSimple(query: string): Promise<ReturnType<typeof formatSuccessResponse>> {
  try {
    // Use SET NOEXEC which parses and compiles but doesn't execute
    const adapter = getDbAdapter();

    // First, set NOEXEC ON
    await dbExec('SET NOEXEC ON');

    let isValid = true;
    let errorMessage = '';
    let errorLine = 0;

    try {
      await dbExec(query);
    } catch (execError) {
      isValid = false;
      errorMessage = (execError as Error).message;

      // Try to extract line number from error message
      const lineMatch = errorMessage.match(/Line (\d+)/i);
      if (lineMatch) {
        errorLine = parseInt(lineMatch[1], 10);
      }
    }

    // Always turn NOEXEC back off
    await dbExec('SET NOEXEC OFF');

    if (isValid) {
      return formatSuccessResponse({
        is_valid: true,
      });
    } else {
      return formatSuccessResponse({
        is_valid: false,
        errors: [
          {
            message: errorMessage,
            line: errorLine,
            position: 0,
          },
        ],
      });
    }
  } catch (error) {
    // Ensure NOEXEC is off even if something goes wrong
    try {
      await dbExec('SET NOEXEC OFF');
    } catch {
      // Ignore error turning off NOEXEC
    }

    throw error;
  }
}

/**
 * Validate and analyze a batch of SQL statements
 */
export async function validateSqlBatch(queries: string[]): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'validate_sql_batch is only supported for SQL Server',
      { suggestion: 'This tool requires SQL Server database' }
    );
  }

  if (!queries || queries.length === 0) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'At least one query is required for validation',
      { suggestion: 'Provide SQL queries to validate' }
    );
  }

  const results: Array<{
    query_index: number;
    query_preview: string;
    is_valid: boolean;
    errors?: SqlValidationError[];
  }> = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const preview = query.substring(0, 100) + (query.length > 100 ? '...' : '');

    try {
      const validationResult = await validateSql(query);
      const parsed = JSON.parse(validationResult.content[0].text);

      results.push({
        query_index: i,
        query_preview: preview,
        is_valid: parsed.is_valid,
        errors: parsed.errors,
      });
    } catch (error) {
      results.push({
        query_index: i,
        query_preview: preview,
        is_valid: false,
        errors: [
          {
            message: (error as Error).message,
            line: 0,
            position: 0,
          },
        ],
      });
    }
  }

  const allValid = results.every((r) => r.is_valid);
  const invalidCount = results.filter((r) => !r.is_valid).length;

  return formatSuccessResponse({
    all_valid: allValid,
    total_queries: queries.length,
    valid_count: queries.length - invalidCount,
    invalid_count: invalidCount,
    results,
  });
}
