/**
 * Backup Manager for MCP SQL Server
 * Handles automatic backups of database objects before modifications
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type {
  BackupEntry,
  BackupLog,
  BackupResult,
  SqlObjectType,
} from '../types/sqlServerTypes.js';
import { getBackupConfig, getProjectRoot } from '../config/mcpConfig.js';

// UTF-8 BOM for SSMS compatibility
const UTF8_BOM = '\uFEFF';

/**
 * Get the backup directory path
 */
export function getBackupDir(): string {
  const config = getBackupConfig();
  return join(getProjectRoot(), config.directory);
}

/**
 * Get subdirectory for object type
 */
function getObjectTypeDir(objectType: string): string {
  const typeMap: Record<string, string> = {
    'PROCEDURE': 'procedures',
    'SQL_STORED_PROCEDURE': 'procedures',
    'FUNCTION': 'functions',
    'SQL_SCALAR_FUNCTION': 'functions',
    'SQL_TABLE_VALUED_FUNCTION': 'functions',
    'SQL_INLINE_TABLE_VALUED_FUNCTION': 'functions',
    'VIEW': 'views',
    'TRIGGER': 'triggers',
    'SQL_TRIGGER': 'triggers',
    'TABLE': 'tables',
    'USER_TABLE': 'tables',
  };
  return typeMap[objectType.toUpperCase()] || 'other';
}

/**
 * Ensure backup directories exist
 */
export function ensureBackupDirs(): void {
  const backupDir = getBackupDir();
  const subdirs = ['procedures', 'functions', 'views', 'triggers', 'tables', 'other'];

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  for (const subdir of subdirs) {
    const subdirPath = join(backupDir, subdir);
    if (!existsSync(subdirPath)) {
      mkdirSync(subdirPath, { recursive: true });
    }
  }
}

/**
 * Get backup log file path
 */
function getBackupLogPath(): string {
  return join(getBackupDir(), 'backup_log.json');
}

/**
 * Load backup log
 */
export function loadBackupLog(): BackupLog {
  const logPath = getBackupLogPath();

  if (!existsSync(logPath)) {
    return {
      version: '1.0',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      backups: [],
    };
  }

  try {
    const content = readFileSync(logPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`[WARN] Failed to load backup log: ${(error as Error).message}`);
    return {
      version: '1.0',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      backups: [],
    };
  }
}

/**
 * Save backup log
 */
function saveBackupLog(log: BackupLog): void {
  const logPath = getBackupLogPath();
  log.updated_at = new Date().toISOString();
  writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
}

/**
 * Generate backup ID
 */
function generateBackupId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `bkp_${timestamp}_${random}`;
}

/**
 * Generate backup filename
 */
function generateBackupFilename(objectName: string, objectType: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .replace(/\..+/, '');

  const sanitizedName = objectName.replace(/[^a-zA-Z0-9_]/g, '_');
  const typeDir = getObjectTypeDir(objectType);

  return `${typeDir}/${sanitizedName}_${timestamp}.sql`;
}

/**
 * Calculate file hash
 */
function calculateHash(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

/**
 * Format backup file content with header
 */
function formatBackupContent(
  objectName: string,
  objectType: string,
  schemaName: string,
  definition: string,
  operation: string,
  database: string
): string {
  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').replace(/\..+/, '');

  const header = `/*
============================================================
BACKUP AUTOMÁTICO - MCP SQL Server
============================================================
Objeto:      ${objectName}
Tipo:        ${objectType}
Schema:      ${schemaName}
Fecha:       ${timestamp}
Operación:   ${operation}
Base Datos:  ${database}
============================================================
PARA RESTAURAR: Ejecute el contenido de este archivo en SSMS
============================================================
*/

`;

  return UTF8_BOM + header + definition;
}

/**
 * Create a backup of a database object
 */
export async function createBackup(
  objectName: string,
  objectType: string,
  schemaName: string,
  definition: string,
  operation: 'ALTER' | 'DROP' | 'CREATE' | 'RESTORE',
  database: string
): Promise<BackupResult> {
  const config = getBackupConfig();

  if (!config.enabled) {
    return {
      success: false,
      message: 'Backup is disabled in configuration',
      backup_file: '',
      backup_id: '',
    };
  }

  try {
    ensureBackupDirs();

    const backupId = generateBackupId();
    const backupFilename = generateBackupFilename(objectName, objectType);
    const backupPath = join(getBackupDir(), backupFilename);

    // Ensure subdirectory exists
    const backupSubdir = dirname(backupPath);
    if (!existsSync(backupSubdir)) {
      mkdirSync(backupSubdir, { recursive: true });
    }

    // Format and write backup content
    const content = formatBackupContent(
      objectName,
      objectType,
      schemaName,
      definition,
      operation,
      database
    );

    writeFileSync(backupPath, content, 'utf-8');

    // Update backup log
    const log = loadBackupLog();
    const entry: BackupEntry = {
      id: backupId,
      timestamp: new Date().toISOString(),
      operation,
      object_type: objectType,
      object_name: objectName,
      schema_name: schemaName,
      database,
      backup_file: backupFilename,
      file_hash: calculateHash(content),
      success: true,
    };

    log.backups.unshift(entry); // Add to beginning

    // Cleanup old backups if needed
    if (config.auto_cleanup) {
      cleanupOldBackups(log, objectName, config.max_backups_per_object);
    }

    saveBackupLog(log);

    console.error(`[INFO] Backup created: ${backupFilename}`);

    return {
      success: true,
      message: `Backup created successfully`,
      backup_file: backupFilename,
      backup_id: backupId,
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error(`[ERROR] Failed to create backup: ${errorMessage}`);

    return {
      success: false,
      message: `Failed to create backup: ${errorMessage}`,
      backup_file: '',
      backup_id: '',
    };
  }
}

/**
 * Clean up old backups for an object
 */
function cleanupOldBackups(log: BackupLog, objectName: string, maxBackups: number): void {
  const objectBackups = log.backups.filter(
    (b) => b.object_name.toLowerCase() === objectName.toLowerCase()
  );

  if (objectBackups.length > maxBackups) {
    const toRemove = objectBackups.slice(maxBackups);

    for (const backup of toRemove) {
      try {
        const filePath = join(getBackupDir(), backup.backup_file);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
        // Remove from log
        const index = log.backups.findIndex((b) => b.id === backup.id);
        if (index !== -1) {
          log.backups.splice(index, 1);
        }
      } catch (error) {
        console.error(`[WARN] Failed to cleanup backup ${backup.backup_file}: ${(error as Error).message}`);
      }
    }
  }
}

/**
 * List backups with optional filters
 */
export function listBackups(
  objectName?: string,
  objectType?: string,
  limit: number = 50
): BackupEntry[] {
  const log = loadBackupLog();
  let backups = log.backups;

  if (objectName) {
    backups = backups.filter(
      (b) => b.object_name.toLowerCase() === objectName.toLowerCase()
    );
  }

  if (objectType) {
    const normalizedType = objectType.toUpperCase();
    backups = backups.filter((b) => {
      const bType = b.object_type.toUpperCase();
      return bType.includes(normalizedType) || normalizedType.includes(bType);
    });
  }

  return backups.slice(0, limit);
}

/**
 * Get a specific backup by ID
 */
export function getBackupById(backupId: string): BackupEntry | null {
  const log = loadBackupLog();
  return log.backups.find((b) => b.id === backupId) || null;
}

/**
 * Get backup content by ID
 */
export function getBackupContent(backupId: string): string | null {
  const backup = getBackupById(backupId);
  if (!backup) {
    return null;
  }

  const filePath = join(getBackupDir(), backup.backup_file);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    let content = readFileSync(filePath, 'utf-8');
    // Remove BOM if present
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
    return content;
  } catch (error) {
    console.error(`[ERROR] Failed to read backup content: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Extract definition from backup content (remove header)
 */
export function extractDefinitionFromBackup(content: string): string {
  // Find the end of the header (after the last ============ line before code)
  const headerEndMarker = '============================================================\n*/\n\n';
  const headerEndIndex = content.lastIndexOf(headerEndMarker);

  if (headerEndIndex !== -1) {
    return content.substring(headerEndIndex + headerEndMarker.length);
  }

  // Fallback: try to find CREATE or ALTER statement
  const createMatch = content.match(/(CREATE|ALTER)\s+(PROCEDURE|FUNCTION|VIEW|TRIGGER|TABLE)/i);
  if (createMatch && createMatch.index !== undefined) {
    return content.substring(createMatch.index);
  }

  return content;
}

/**
 * Cleanup backups older than specified days
 */
export function cleanupByAge(days: number): number {
  const log = loadBackupLog();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  let removed = 0;

  const toKeep: BackupEntry[] = [];

  for (const backup of log.backups) {
    const backupDate = new Date(backup.timestamp);

    if (backupDate < cutoffDate) {
      try {
        const filePath = join(getBackupDir(), backup.backup_file);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
        removed++;
      } catch (error) {
        console.error(`[WARN] Failed to delete old backup: ${(error as Error).message}`);
        toKeep.push(backup); // Keep in log if file deletion failed
      }
    } else {
      toKeep.push(backup);
    }
  }

  log.backups = toKeep;
  saveBackupLog(log);

  return removed;
}

/**
 * Get backup statistics
 */
export function getBackupStats(): {
  total_backups: number;
  by_type: Record<string, number>;
  by_operation: Record<string, number>;
  oldest_backup: string | null;
  newest_backup: string | null;
  total_size_bytes: number;
} {
  const log = loadBackupLog();
  const backupDir = getBackupDir();

  const stats = {
    total_backups: log.backups.length,
    by_type: {} as Record<string, number>,
    by_operation: {} as Record<string, number>,
    oldest_backup: null as string | null,
    newest_backup: null as string | null,
    total_size_bytes: 0,
  };

  for (const backup of log.backups) {
    // Count by type
    const typeDir = getObjectTypeDir(backup.object_type);
    stats.by_type[typeDir] = (stats.by_type[typeDir] || 0) + 1;

    // Count by operation
    stats.by_operation[backup.operation] = (stats.by_operation[backup.operation] || 0) + 1;

    // Track oldest/newest
    if (!stats.oldest_backup || backup.timestamp < stats.oldest_backup) {
      stats.oldest_backup = backup.timestamp;
    }
    if (!stats.newest_backup || backup.timestamp > stats.newest_backup) {
      stats.newest_backup = backup.timestamp;
    }

    // Calculate size
    try {
      const filePath = join(backupDir, backup.backup_file);
      if (existsSync(filePath)) {
        const stat = statSync(filePath);
        stats.total_size_bytes += stat.size;
      }
    } catch {
      // Ignore size calculation errors
    }
  }

  return stats;
}
