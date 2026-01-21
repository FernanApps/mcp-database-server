/**
 * Alter Tools for MCP SQL Server
 * Tools for modifying database objects (procedures, functions, views, triggers)
 * All operations include automatic backup before modification
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll, dbExec, getDatabaseType, getDatabaseMetadata } from '../db/index.js';
import { createBackup } from '../backup/backupManager.js';
import { getSecurityConfig } from '../config/mcpConfig.js';
import type { AlterResult, DropResult, CreateResult, SqlObjectType } from '../types/sqlServerTypes.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * Get object definition from database
 */
async function getObjectDefinitionInternal(objectName: string): Promise<{
  definition: string;
  object_type: string;
  schema_name: string;
} | null> {
  const query = `
    SELECT
      m.definition,
      o.type_desc AS object_type,
      SCHEMA_NAME(o.schema_id) AS schema_name
    FROM sys.objects o
    INNER JOIN sys.sql_modules m ON o.object_id = m.object_id
    WHERE o.name = '${objectName.replace(/'/g, "''")}'
  `;

  const results = await dbAll(query);
  if (results.length === 0) {
    return null;
  }

  return {
    definition: results[0].definition,
    object_type: results[0].object_type,
    schema_name: results[0].schema_name,
  };
}

/**
 * Verify object exists and get its info
 */
async function verifyObjectExists(objectName: string, expectedType?: string): Promise<{
  exists: boolean;
  definition?: string;
  object_type?: string;
  schema_name?: string;
}> {
  const obj = await getObjectDefinitionInternal(objectName);

  if (!obj) {
    return { exists: false };
  }

  if (expectedType) {
    const typeMap: Record<string, string[]> = {
      'PROCEDURE': ['SQL_STORED_PROCEDURE'],
      'FUNCTION': ['SQL_SCALAR_FUNCTION', 'SQL_TABLE_VALUED_FUNCTION', 'SQL_INLINE_TABLE_VALUED_FUNCTION'],
      'VIEW': ['VIEW'],
      'TRIGGER': ['SQL_TRIGGER'],
    };

    const allowedTypes = typeMap[expectedType.toUpperCase()] || [];
    if (!allowedTypes.includes(obj.object_type)) {
      return { exists: false };
    }
  }

  return {
    exists: true,
    definition: obj.definition,
    object_type: obj.object_type,
    schema_name: obj.schema_name,
  };
}

/**
 * Alter a stored procedure
 */
export async function alterProcedure(
  procedureName: string,
  newDefinition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'alter_procedure is only supported for SQL Server'
    );
  }

  const security = getSecurityConfig();

  if (security.require_confirm_for_alter && !confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.',
      { suggestion: 'Add confirm: true to the parameters to confirm this operation' }
    );
  }

  if (!procedureName) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Procedure name is required'
    );
  }

  if (!newDefinition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'New definition is required'
    );
  }

  try {
    // Verify procedure exists
    const existingObj = await verifyObjectExists(procedureName, 'PROCEDURE');
    if (!existingObj.exists) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Procedure '${procedureName}' not found`,
        { object_name: procedureName, object_type: 'PROCEDURE' }
      );
    }

    // Create backup before modification
    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      procedureName,
      existingObj.object_type!,
      existingObj.schema_name!,
      existingObj.definition!,
      'ALTER',
      metadata.database || metadata.name
    );

    if (!backupResult.success) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Failed to create backup: ${backupResult.message}`,
        { suggestion: 'Ensure backup directory is writable' }
      );
    }

    // Execute the ALTER statement
    // Ensure the definition starts with ALTER PROCEDURE
    let finalDefinition = newDefinition.trim();
    if (finalDefinition.toUpperCase().startsWith('CREATE PROCEDURE')) {
      finalDefinition = finalDefinition.replace(/^CREATE\s+PROCEDURE/i, 'ALTER PROCEDURE');
    }

    await dbExec(finalDefinition);

    const result: AlterResult = {
      success: true,
      message: `Procedure '${procedureName}' altered successfully`,
      backup_file: backupResult.backup_file,
      backup_id: backupResult.backup_id,
      object_name: procedureName,
      object_type: 'PROCEDURE',
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error altering procedure: ${(error as Error).message}`,
      { object_name: procedureName }
    );
  }
}

/**
 * Alter a function
 */
export async function alterFunction(
  functionName: string,
  newDefinition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'alter_function is only supported for SQL Server'
    );
  }

  const security = getSecurityConfig();

  if (security.require_confirm_for_alter && !confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.'
    );
  }

  if (!functionName || !newDefinition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Function name and new definition are required'
    );
  }

  try {
    const existingObj = await verifyObjectExists(functionName, 'FUNCTION');
    if (!existingObj.exists) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Function '${functionName}' not found`,
        { object_name: functionName, object_type: 'FUNCTION' }
      );
    }

    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      functionName,
      existingObj.object_type!,
      existingObj.schema_name!,
      existingObj.definition!,
      'ALTER',
      metadata.database || metadata.name
    );

    if (!backupResult.success) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Failed to create backup: ${backupResult.message}`
      );
    }

    let finalDefinition = newDefinition.trim();
    if (finalDefinition.toUpperCase().startsWith('CREATE FUNCTION')) {
      finalDefinition = finalDefinition.replace(/^CREATE\s+FUNCTION/i, 'ALTER FUNCTION');
    }

    await dbExec(finalDefinition);

    const result: AlterResult = {
      success: true,
      message: `Function '${functionName}' altered successfully`,
      backup_file: backupResult.backup_file,
      backup_id: backupResult.backup_id,
      object_name: functionName,
      object_type: 'FUNCTION',
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error altering function: ${(error as Error).message}`,
      { object_name: functionName }
    );
  }
}

/**
 * Alter a view
 */
export async function alterView(
  viewName: string,
  newDefinition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'alter_view is only supported for SQL Server'
    );
  }

  const security = getSecurityConfig();

  if (security.require_confirm_for_alter && !confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.'
    );
  }

  if (!viewName || !newDefinition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'View name and new definition are required'
    );
  }

  try {
    const existingObj = await verifyObjectExists(viewName, 'VIEW');
    if (!existingObj.exists) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `View '${viewName}' not found`,
        { object_name: viewName, object_type: 'VIEW' }
      );
    }

    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      viewName,
      existingObj.object_type!,
      existingObj.schema_name!,
      existingObj.definition!,
      'ALTER',
      metadata.database || metadata.name
    );

    if (!backupResult.success) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Failed to create backup: ${backupResult.message}`
      );
    }

    let finalDefinition = newDefinition.trim();
    if (finalDefinition.toUpperCase().startsWith('CREATE VIEW')) {
      finalDefinition = finalDefinition.replace(/^CREATE\s+VIEW/i, 'ALTER VIEW');
    }

    await dbExec(finalDefinition);

    const result: AlterResult = {
      success: true,
      message: `View '${viewName}' altered successfully`,
      backup_file: backupResult.backup_file,
      backup_id: backupResult.backup_id,
      object_name: viewName,
      object_type: 'VIEW',
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error altering view: ${(error as Error).message}`,
      { object_name: viewName }
    );
  }
}

/**
 * Drop a database object
 */
export async function dropObject(
  objectName: string,
  objectType: SqlObjectType,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'drop_object is only supported for SQL Server'
    );
  }

  const security = getSecurityConfig();

  if (security.require_confirm_for_drop && !confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.',
      { suggestion: 'WARNING: This will permanently delete the object. A backup will be created first.' }
    );
  }

  if (!objectName || !objectType) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Object name and type are required'
    );
  }

  if (objectType === 'ALL') {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Cannot drop ALL objects. Specify a specific object type.'
    );
  }

  try {
    const existingObj = await verifyObjectExists(objectName, objectType);
    if (!existingObj.exists) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `${objectType} '${objectName}' not found`,
        { object_name: objectName, object_type: objectType }
      );
    }

    const metadata = getDatabaseMetadata();
    const backupResult = await createBackup(
      objectName,
      existingObj.object_type!,
      existingObj.schema_name!,
      existingObj.definition!,
      'DROP',
      metadata.database || metadata.name
    );

    if (!backupResult.success) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Failed to create backup: ${backupResult.message}`
      );
    }

    // Build DROP statement
    const dropTypeMap: Record<string, string> = {
      'PROCEDURE': 'PROCEDURE',
      'FUNCTION': 'FUNCTION',
      'VIEW': 'VIEW',
      'TRIGGER': 'TRIGGER',
    };

    const dropType = dropTypeMap[objectType.toUpperCase()];
    const dropQuery = `DROP ${dropType} [${existingObj.schema_name}].[${objectName}]`;

    await dbExec(dropQuery);

    const result: DropResult = {
      success: true,
      message: `${objectType} '${objectName}' dropped successfully. Backup created.`,
      backup_file: backupResult.backup_file,
      backup_id: backupResult.backup_id,
      restore_command: `Use restore_from_backup with backup_id: '${backupResult.backup_id}'`,
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error dropping object: ${(error as Error).message}`,
      { object_name: objectName, object_type: objectType }
    );
  }
}

/**
 * Create a new stored procedure
 */
export async function createProcedure(
  procedureName: string,
  definition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'create_procedure is only supported for SQL Server'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.'
    );
  }

  if (!procedureName || !definition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Procedure name and definition are required'
    );
  }

  try {
    // Check if procedure already exists
    const existingObj = await verifyObjectExists(procedureName, 'PROCEDURE');
    if (existingObj.exists) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        `Procedure '${procedureName}' already exists. Use alter_procedure to modify it.`,
        { object_name: procedureName, object_type: 'PROCEDURE' }
      );
    }

    // Ensure definition starts with CREATE PROCEDURE
    let finalDefinition = definition.trim();
    if (!finalDefinition.toUpperCase().startsWith('CREATE PROCEDURE')) {
      throw new McpSqlServerError(
        'SYNTAX_ERROR',
        'Definition must start with CREATE PROCEDURE',
        { suggestion: 'Provide the complete CREATE PROCEDURE statement' }
      );
    }

    await dbExec(finalDefinition);

    const result: CreateResult = {
      success: true,
      message: `Procedure '${procedureName}' created successfully`,
      object_name: procedureName,
      object_type: 'PROCEDURE',
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error creating procedure: ${(error as Error).message}`,
      { object_name: procedureName }
    );
  }
}

/**
 * Create a new function
 */
export async function createFunction(
  functionName: string,
  definition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'create_function is only supported for SQL Server'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.'
    );
  }

  if (!functionName || !definition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Function name and definition are required'
    );
  }

  try {
    const existingObj = await verifyObjectExists(functionName, 'FUNCTION');
    if (existingObj.exists) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        `Function '${functionName}' already exists. Use alter_function to modify it.`
      );
    }

    let finalDefinition = definition.trim();
    if (!finalDefinition.toUpperCase().startsWith('CREATE FUNCTION')) {
      throw new McpSqlServerError(
        'SYNTAX_ERROR',
        'Definition must start with CREATE FUNCTION'
      );
    }

    await dbExec(finalDefinition);

    const result: CreateResult = {
      success: true,
      message: `Function '${functionName}' created successfully`,
      object_name: functionName,
      object_type: 'FUNCTION',
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error creating function: ${(error as Error).message}`,
      { object_name: functionName }
    );
  }
}

/**
 * Create a new view
 */
export async function createView(
  viewName: string,
  definition: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'create_view is only supported for SQL Server'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.'
    );
  }

  if (!viewName || !definition) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'View name and definition are required'
    );
  }

  try {
    const existingObj = await verifyObjectExists(viewName, 'VIEW');
    if (existingObj.exists) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        `View '${viewName}' already exists. Use alter_view to modify it.`
      );
    }

    let finalDefinition = definition.trim();
    if (!finalDefinition.toUpperCase().startsWith('CREATE VIEW')) {
      throw new McpSqlServerError(
        'SYNTAX_ERROR',
        'Definition must start with CREATE VIEW'
      );
    }

    await dbExec(finalDefinition);

    const result: CreateResult = {
      success: true,
      message: `View '${viewName}' created successfully`,
      object_name: viewName,
      object_type: 'VIEW',
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'SYNTAX_ERROR',
      `Error creating view: ${(error as Error).message}`,
      { object_name: viewName }
    );
  }
}
