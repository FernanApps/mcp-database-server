/**
 * Types and interfaces for SQL Server advanced operations
 * MCP SQL Server Improvements
 */

// ============================================================
// OBJECT DEFINITION TYPES
// ============================================================

export type SqlObjectType = 'PROCEDURE' | 'FUNCTION' | 'VIEW' | 'TRIGGER' | 'ALL';

export interface ObjectDefinition {
  object_name: string;
  object_type: string;
  schema_name: string;
  definition: string;
  created_date: string;
  modified_date: string;
}

export interface DbObject {
  name: string;
  type: string;
  schema_name: string;
  created_date: string;
  modified_date: string;
}

export interface SearchMatch {
  object_name: string;
  object_type: string;
  line_number: number;
  line_content: string;
}

// ============================================================
// DEPENDENCY TYPES
// ============================================================

export interface DependencyObject {
  name: string;
  type: string;
  schema_name?: string;
}

export interface Dependencies {
  object_name: string;
  uses: DependencyObject[];
  used_by: DependencyObject[];
}

// ============================================================
// TABLE INFO TYPES
// ============================================================

export interface ColumnInfo {
  name: string;
  data_type: string;
  max_length: number | null;
  precision: number | null;
  scale: number | null;
  is_nullable: boolean;
  is_primary_key: boolean;
  is_identity: boolean;
  is_computed: boolean;
  default_value: string | null;
}

export interface IndexInfo {
  name: string;
  type: string;
  columns: string[];
  is_unique: boolean;
  is_primary_key: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  references_table: string;
  references_column: string;
  on_delete: string;
  on_update: string;
}

export interface ReferencedByInfo {
  table_name: string;
  fk_name: string;
  column: string;
}

export interface ExtendedTableInfo {
  table_name: string;
  schema_name: string;
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  foreign_keys?: ForeignKeyInfo[];
  referenced_by?: ReferencedByInfo[];
  row_count?: number;
}

export interface TableInfoOptions {
  include_indexes?: boolean;
  include_foreign_keys?: boolean;
  include_row_count?: boolean;
}

// ============================================================
// VALIDATION TYPES
// ============================================================

export interface SqlValidationError {
  message: string;
  line: number;
  position: number;
  error_number?: number;
}

export interface ValidationResult {
  is_valid: boolean;
  errors?: SqlValidationError[];
}

// ============================================================
// BACKUP TYPES
// ============================================================

export interface BackupEntry {
  id: string;
  timestamp: string;
  operation: 'ALTER' | 'DROP' | 'CREATE' | 'RESTORE';
  object_type: string;
  object_name: string;
  schema_name: string;
  database: string;
  backup_file: string;
  file_hash: string;
  success: boolean;
  error_message?: string;
}

export interface BackupLog {
  version: string;
  created_at: string;
  updated_at: string;
  backups: BackupEntry[];
}

export interface BackupResult {
  success: boolean;
  message: string;
  backup_file: string;
  backup_id: string;
}

export interface RestoreResult {
  success: boolean;
  message: string;
  restored_object: string;
  new_backup_file: string;
  new_backup_id: string;
}

export interface DiffResult {
  object_name: string;
  old_version: {
    backup_id: string;
    timestamp: string;
  };
  new_version: {
    backup_id: string | 'current';
    timestamp: string;
  };
  diff: string;
  lines_added: number;
  lines_removed: number;
  is_identical: boolean;
}

// ============================================================
// PROCEDURE EXECUTION TYPES
// ============================================================

export interface ProcedureParameter {
  name: string;
  value: any;
  type?: string;
  is_output?: boolean;
}

export interface ProcedureResult {
  success: boolean;
  result_sets: Array<Array<Record<string, any>>>;
  output_parameters?: Record<string, any>;
  rows_affected: number;
  execution_time_ms: number;
  warnings?: string[];
  has_writes: boolean;
}

export interface ProcedureInfo {
  name: string;
  schema_name: string;
  has_writes: boolean;
  parameters: Array<{
    name: string;
    type: string;
    max_length: number | null;
    is_output: boolean;
    has_default: boolean;
  }>;
}

// ============================================================
// ALTER OPERATION TYPES
// ============================================================

export interface AlterResult {
  success: boolean;
  message: string;
  backup_file: string;
  backup_id: string;
  object_name: string;
  object_type: string;
}

export interface DropResult {
  success: boolean;
  message: string;
  backup_file: string;
  backup_id: string;
  restore_command: string;
}

export interface CreateResult {
  success: boolean;
  message: string;
  object_name: string;
  object_type: string;
}

// ============================================================
// CONFIGURATION TYPES
// ============================================================

export interface BackupConfig {
  enabled: boolean;
  directory: string;
  max_backups_per_object: number;
  auto_cleanup: boolean;
  cleanup_days: number;
}

export interface SecurityConfig {
  require_confirm_for_alter: boolean;
  require_confirm_for_drop: boolean;
  require_confirm_for_exec_with_writes: boolean;
  blocked_procedures: string[];
}

export interface LimitsConfig {
  default_timeout_seconds: number;
  max_timeout_seconds: number;
  default_max_rows: number;
  max_rows: number;
}

export interface McpSqlServerConfig {
  backup: BackupConfig;
  security: SecurityConfig;
  limits: LimitsConfig;
}

// ============================================================
// ERROR TYPES
// ============================================================

export type McpErrorCode =
  | 'CONFIRM_REQUIRED'
  | 'OBJECT_NOT_FOUND'
  | 'BACKUP_FAILED'
  | 'SYNTAX_ERROR'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'MAX_ROWS_EXCEEDED'
  | 'INVALID_OPERATION'
  | 'DATABASE_NOT_SUPPORTED'
  | 'RESTORE_FAILED';

export interface McpSqlError {
  code: McpErrorCode;
  message: string;
  details?: {
    sql_error_number?: number;
    sql_error_message?: string;
    line?: number;
    suggestion?: string;
    object_name?: string;
    object_type?: string;
  };
}

export class McpSqlServerError extends Error {
  public code: McpErrorCode;
  public details?: McpSqlError['details'];

  constructor(code: McpErrorCode, message: string, details?: McpSqlError['details']) {
    super(message);
    this.name = 'McpSqlServerError';
    this.code = code;
    this.details = details;
  }

  toJSON(): McpSqlError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// ============================================================
// EXTENDED DB ADAPTER INTERFACE
// ============================================================

export interface SqlServerExtendedAdapter {
  // Object definition methods
  getObjectDefinition(objectName: string, objectType?: SqlObjectType): Promise<ObjectDefinition | null>;
  listObjects(objectType: SqlObjectType, schema?: string, filter?: string): Promise<DbObject[]>;
  searchInObjects(searchText: string, objectTypes?: SqlObjectType[], caseSensitive?: boolean): Promise<SearchMatch[]>;

  // Dependency methods
  getDependencies(objectName: string, direction: 'uses' | 'used_by' | 'both'): Promise<Dependencies>;

  // Table info methods
  getExtendedTableInfo(tableName: string, options?: TableInfoOptions): Promise<ExtendedTableInfo | null>;

  // Validation methods
  validateSql(query: string): Promise<ValidationResult>;

  // Procedure methods
  getProcedureInfo(procedureName: string): Promise<ProcedureInfo | null>;
  execProcedure(
    procedureName: string,
    parameters?: Record<string, any>,
    options?: { timeout?: number; maxRows?: number }
  ): Promise<ProcedureResult>;

  // Alter methods
  alterObject(objectType: SqlObjectType, objectName: string, newDefinition: string): Promise<void>;
  dropObject(objectType: SqlObjectType, objectName: string): Promise<void>;
  createObject(objectType: SqlObjectType, definition: string): Promise<string>;
}
