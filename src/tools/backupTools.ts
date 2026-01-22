/**
 * Backup Tools for MCP SQL Server
 * Tools for managing backups, restoration, and comparing versions
 */

import { formatSuccessResponse } from '../utils/formatUtils.js';
import { dbAll, dbExec, getDatabaseType, getDatabaseMetadata } from '../db/index.js';
import {
  listBackups as listBackupsFromManager,
  getBackupById,
  getBackupContent,
  extractDefinitionFromBackup,
  createBackup,
  getBackupStats,
  cleanupByAge,
} from '../backup/backupManager.js';
import { compareBackups, generateChangeSummary } from '../backup/diffUtils.js';
import { getSecurityConfig, getBackupConfig } from '../config/mcpConfig.js';
import type { RestoreResult, DiffResult } from '../types/sqlServerTypes.js';
import { McpSqlServerError } from '../types/sqlServerTypes.js';

/**
 * List available backups
 */
export async function listBackups(
  objectName?: string,
  objectType?: string,
  limit: number = 50
): Promise<ReturnType<typeof formatSuccessResponse>> {
  try {
    const backups = listBackupsFromManager(objectName, objectType, limit);
    const stats = getBackupStats();

    return formatSuccessResponse({
      count: backups.length,
      total_backups: stats.total_backups,
      filters: {
        object_name: objectName || null,
        object_type: objectType || null,
        limit,
      },
      backups: backups.map((b) => ({
        backup_id: b.id,
        timestamp: b.timestamp,
        operation: b.operation,
        object_name: b.object_name,
        object_type: b.object_type,
        schema_name: b.schema_name,
        database: b.database,
        backup_file: b.backup_file,
      })),
    });
  } catch (error) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error listing backups: ${(error as Error).message}`
    );
  }
}

/**
 * Get backup statistics
 */
export async function getBackupStatistics(): Promise<ReturnType<typeof formatSuccessResponse>> {
  try {
    const stats = getBackupStats();

    return formatSuccessResponse({
      total_backups: stats.total_backups,
      by_type: stats.by_type,
      by_operation: stats.by_operation,
      oldest_backup: stats.oldest_backup,
      newest_backup: stats.newest_backup,
      total_size_mb: Math.round(stats.total_size_bytes / 1024 / 1024 * 100) / 100,
    });
  } catch (error) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting backup statistics: ${(error as Error).message}`
    );
  }
}

/**
 * Restore from a backup
 */
export async function restoreFromBackup(
  backupId: string,
  confirm: boolean
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (dbType !== 'sqlserver') {
    throw new McpSqlServerError(
      'DATABASE_NOT_SUPPORTED',
      'restore_from_backup is only supported for SQL Server'
    );
  }

  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.',
      { suggestion: 'A backup of the current state will be created before restoring' }
    );
  }

  if (!backupId) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Backup ID is required'
    );
  }

  try {
    // Get the backup to restore
    const backup = getBackupById(backupId);
    if (!backup) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Backup '${backupId}' not found`,
        { suggestion: 'Use list_backups to see available backups' }
      );
    }

    // Get the backup content
    const content = getBackupContent(backupId);
    if (!content) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Could not read backup content for '${backupId}'`,
        { suggestion: 'The backup file may have been deleted or moved' }
      );
    }

    // Extract the definition
    const definition = extractDefinitionFromBackup(content);

    // Check if the object currently exists
    const existsQuery = `
      SELECT
        m.definition,
        o.type_desc AS object_type,
        SCHEMA_NAME(o.schema_id) AS schema_name
      FROM sys.objects o
      INNER JOIN sys.sql_modules m ON o.object_id = m.object_id
      WHERE o.name = '${backup.object_name.replace(/'/g, "''")}'
    `;

    const existsResults = await dbAll(existsQuery);
    const objectExists = existsResults.length > 0;

    // Create backup of current state before restoring
    let preRestoreBackupId = '';
    let preRestoreBackupFile = '';

    if (objectExists) {
      const metadata = getDatabaseMetadata();
      const preRestoreBackup = await createBackup(
        backup.object_name,
        existsResults[0].object_type,
        existsResults[0].schema_name,
        existsResults[0].definition,
        'RESTORE',
        metadata.database || metadata.name
      );

      if (preRestoreBackup.success) {
        preRestoreBackupId = preRestoreBackup.backup_id;
        preRestoreBackupFile = preRestoreBackup.backup_file;
      }
    }

    // Determine if we need CREATE or ALTER
    let restoreDefinition = definition;
    if (objectExists) {
      // Replace CREATE with ALTER - use global regex that handles whitespace/newlines before CREATE
      restoreDefinition = definition
        .replace(/\bCREATE\s+(PROCEDURE)/gi, 'ALTER $1')
        .replace(/\bCREATE\s+(FUNCTION)/gi, 'ALTER $1')
        .replace(/\bCREATE\s+(VIEW)/gi, 'ALTER $1')
        .replace(/\bCREATE\s+(TRIGGER)/gi, 'ALTER $1');
    }

    // Remove GO statements (SSMS batch separator, not valid T-SQL)
    restoreDefinition = restoreDefinition.replace(/^\s*GO\s*$/gim, '');

    // Execute the restore
    await dbExec(restoreDefinition);

    const result: RestoreResult = {
      success: true,
      message: `Successfully restored '${backup.object_name}' from backup ${backupId}`,
      restored_object: backup.object_name,
      new_backup_file: preRestoreBackupFile,
      new_backup_id: preRestoreBackupId,
    };

    return formatSuccessResponse(result);
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'RESTORE_FAILED',
      `Error restoring from backup: ${(error as Error).message}`,
      { suggestion: 'Check the backup content for syntax errors' }
    );
  }
}

/**
 * Compare two backup versions
 */
export async function diffBackups(
  backupIdOld: string,
  backupIdNew: string | 'current'
): Promise<ReturnType<typeof formatSuccessResponse>> {
  const dbType = getDatabaseType();

  if (!backupIdOld) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Old backup ID is required'
    );
  }

  if (!backupIdNew) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'New backup ID or "current" is required'
    );
  }

  try {
    let currentDefinition: string | undefined;

    // If comparing with current, get the current definition
    if (backupIdNew === 'current') {
      if (dbType !== 'sqlserver') {
        throw new McpSqlServerError(
          'DATABASE_NOT_SUPPORTED',
          'Comparing with current version is only supported for SQL Server'
        );
      }

      const oldBackup = getBackupById(backupIdOld);
      if (!oldBackup) {
        throw new McpSqlServerError(
          'OBJECT_NOT_FOUND',
          `Backup '${backupIdOld}' not found`
        );
      }

      const currentQuery = `
        SELECT m.definition
        FROM sys.objects o
        INNER JOIN sys.sql_modules m ON o.object_id = m.object_id
        WHERE o.name = '${oldBackup.object_name.replace(/'/g, "''")}'
      `;

      const currentResults = await dbAll(currentQuery);
      if (currentResults.length === 0) {
        throw new McpSqlServerError(
          'OBJECT_NOT_FOUND',
          `Object '${oldBackup.object_name}' not found in database`,
          { suggestion: 'The object may have been dropped' }
        );
      }

      currentDefinition = currentResults[0].definition;
    }

    const diffResult = compareBackups(backupIdOld, backupIdNew, currentDefinition);

    if (!diffResult) {
      throw new McpSqlServerError(
        'INVALID_OPERATION',
        'Could not compare backups. One or both backup IDs may be invalid.'
      );
    }

    return formatSuccessResponse({
      ...diffResult,
      summary: generateChangeSummary(diffResult),
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error comparing backups: ${(error as Error).message}`
    );
  }
}

/**
 * Get the content of a specific backup
 */
export async function getBackup(backupId: string): Promise<ReturnType<typeof formatSuccessResponse>> {
  if (!backupId) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      'Backup ID is required'
    );
  }

  try {
    const backup = getBackupById(backupId);
    if (!backup) {
      throw new McpSqlServerError(
        'OBJECT_NOT_FOUND',
        `Backup '${backupId}' not found`
      );
    }

    const content = getBackupContent(backupId);
    if (!content) {
      throw new McpSqlServerError(
        'BACKUP_FAILED',
        `Could not read backup content for '${backupId}'`
      );
    }

    return formatSuccessResponse({
      backup_id: backup.id,
      timestamp: backup.timestamp,
      operation: backup.operation,
      object_name: backup.object_name,
      object_type: backup.object_type,
      schema_name: backup.schema_name,
      database: backup.database,
      backup_file: backup.backup_file,
      definition: extractDefinitionFromBackup(content),
    });
  } catch (error) {
    if (error instanceof McpSqlServerError) {
      throw error;
    }
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error getting backup: ${(error as Error).message}`
    );
  }
}

/**
 * Cleanup old backups
 */
export async function cleanupBackups(
  days?: number,
  confirm: boolean = false
): Promise<ReturnType<typeof formatSuccessResponse>> {
  if (!confirm) {
    throw new McpSqlServerError(
      'CONFIRM_REQUIRED',
      'This operation requires confirmation. Set confirm=true to proceed.',
      { suggestion: 'This will permanently delete old backup files' }
    );
  }

  try {
    const config = getBackupConfig();
    const cleanupDays = days || config.cleanup_days;

    const removedCount = cleanupByAge(cleanupDays);

    return formatSuccessResponse({
      success: true,
      message: `Cleaned up ${removedCount} backups older than ${cleanupDays} days`,
      removed_count: removedCount,
    });
  } catch (error) {
    throw new McpSqlServerError(
      'INVALID_OPERATION',
      `Error cleaning up backups: ${(error as Error).message}`
    );
  }
}
