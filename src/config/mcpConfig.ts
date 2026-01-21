/**
 * Configuration management for MCP SQL Server
 * Handles loading and merging configuration from .mcp-sqlserver.json
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { McpSqlServerConfig, BackupConfig, SecurityConfig, LimitsConfig } from '../types/sqlServerTypes.js';

// Default configuration
const DEFAULT_CONFIG: McpSqlServerConfig = {
  backup: {
    enabled: true,
    directory: '.sql_backups',
    max_backups_per_object: 50,
    auto_cleanup: true,
    cleanup_days: 30,
  },
  security: {
    require_confirm_for_alter: true,
    require_confirm_for_drop: true,
    require_confirm_for_exec_with_writes: true,
    blocked_procedures: ['sp_executesql', 'xp_cmdshell', 'xp_regread', 'xp_regwrite', 'xp_instance_regread'],
  },
  limits: {
    default_timeout_seconds: 30,
    max_timeout_seconds: 120,
    default_max_rows: 1000,
    max_rows: 10000,
  },
};

let currentConfig: McpSqlServerConfig = { ...DEFAULT_CONFIG };
let configLoaded = false;
let projectRoot: string = process.cwd();

/**
 * Set the project root directory
 */
export function setProjectRoot(root: string): void {
  projectRoot = root;
  configLoaded = false; // Force reload on next access
}

/**
 * Get the project root directory
 */
export function getProjectRoot(): string {
  return projectRoot;
}

/**
 * Load configuration from .mcp-sqlserver.json file
 */
export function loadConfig(configPath?: string): McpSqlServerConfig {
  const filePath = configPath || join(projectRoot, '.mcp-sqlserver.json');

  if (existsSync(filePath)) {
    try {
      const fileContent = readFileSync(filePath, 'utf-8');
      const userConfig = JSON.parse(fileContent);
      currentConfig = mergeConfig(DEFAULT_CONFIG, userConfig);
      console.error(`[INFO] Loaded configuration from ${filePath}`);
    } catch (error) {
      console.error(`[WARN] Failed to load config from ${filePath}: ${(error as Error).message}`);
      console.error('[WARN] Using default configuration');
      currentConfig = { ...DEFAULT_CONFIG };
    }
  } else {
    console.error('[INFO] No .mcp-sqlserver.json found, using default configuration');
    currentConfig = { ...DEFAULT_CONFIG };
  }

  configLoaded = true;
  return currentConfig;
}

/**
 * Deep merge two configuration objects
 */
function mergeConfig(defaultCfg: McpSqlServerConfig, userCfg: Partial<McpSqlServerConfig>): McpSqlServerConfig {
  return {
    backup: {
      ...defaultCfg.backup,
      ...(userCfg.backup || {}),
    },
    security: {
      ...defaultCfg.security,
      ...(userCfg.security || {}),
      // Merge blocked_procedures arrays instead of replacing
      blocked_procedures: [
        ...new Set([
          ...defaultCfg.security.blocked_procedures,
          ...(userCfg.security?.blocked_procedures || []),
        ]),
      ],
    },
    limits: {
      ...defaultCfg.limits,
      ...(userCfg.limits || {}),
    },
  };
}

/**
 * Get current configuration
 */
export function getConfig(): McpSqlServerConfig {
  if (!configLoaded) {
    loadConfig();
  }
  return currentConfig;
}

/**
 * Get backup configuration
 */
export function getBackupConfig(): BackupConfig {
  return getConfig().backup;
}

/**
 * Get security configuration
 */
export function getSecurityConfig(): SecurityConfig {
  return getConfig().security;
}

/**
 * Get limits configuration
 */
export function getLimitsConfig(): LimitsConfig {
  return getConfig().limits;
}

/**
 * Check if a procedure is blocked
 */
export function isProcedureBlocked(procedureName: string): boolean {
  const security = getSecurityConfig();
  const normalizedName = procedureName.toLowerCase().replace(/[\[\]]/g, '');
  return security.blocked_procedures.some(
    (blocked) => blocked.toLowerCase() === normalizedName
  );
}

/**
 * Get effective timeout (respecting limits)
 */
export function getEffectiveTimeout(requestedTimeout?: number): number {
  const limits = getLimitsConfig();
  if (requestedTimeout === undefined) {
    return limits.default_timeout_seconds * 1000; // Convert to ms
  }
  return Math.min(requestedTimeout, limits.max_timeout_seconds) * 1000;
}

/**
 * Get effective max rows (respecting limits)
 */
export function getEffectiveMaxRows(requestedMaxRows?: number): number {
  const limits = getLimitsConfig();
  if (requestedMaxRows === undefined) {
    return limits.default_max_rows;
  }
  return Math.min(requestedMaxRows, limits.max_rows);
}

/**
 * Get backup directory path
 */
export function getBackupDirectory(): string {
  const backup = getBackupConfig();
  if (!backup.enabled) {
    throw new Error('Backup is disabled in configuration');
  }
  return join(projectRoot, backup.directory);
}

/**
 * Reset configuration to defaults (useful for testing)
 */
export function resetConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
  configLoaded = false;
}
