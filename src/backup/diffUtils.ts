/**
 * Diff utilities for comparing backup versions
 * Simple line-by-line diff implementation
 */

import type { DiffResult } from '../types/sqlServerTypes.js';
import { getBackupById, getBackupContent, extractDefinitionFromBackup } from './backupManager.js';

interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  lineNumber: { old: number | null; new: number | null };
  content: string;
}

/**
 * Calculate Longest Common Subsequence for diff
 */
function lcs(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/**
 * Backtrack to find the diff
 */
function backtrack(
  dp: number[][],
  oldLines: string[],
  newLines: string[],
  i: number,
  j: number
): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  const stack: Array<{ i: number; j: number; action: 'check' | 'unchanged' | 'removed' | 'added' }> = [];
  stack.push({ i, j, action: 'check' });

  const tempResult: DiffLine[] = [];

  // Iterative backtracking
  let currI = i;
  let currJ = j;

  while (currI > 0 || currJ > 0) {
    if (currI > 0 && currJ > 0 && oldLines[currI - 1] === newLines[currJ - 1]) {
      tempResult.push({
        type: 'unchanged',
        lineNumber: { old: currI, new: currJ },
        content: oldLines[currI - 1],
      });
      currI--;
      currJ--;
    } else if (currJ > 0 && (currI === 0 || dp[currI][currJ - 1] >= dp[currI - 1][currJ])) {
      tempResult.push({
        type: 'added',
        lineNumber: { old: null, new: currJ },
        content: newLines[currJ - 1],
      });
      currJ--;
    } else if (currI > 0) {
      tempResult.push({
        type: 'removed',
        lineNumber: { old: currI, new: null },
        content: oldLines[currI - 1],
      });
      currI--;
    }
  }

  return tempResult.reverse();
}

/**
 * Generate diff between two texts
 */
export function generateDiff(oldText: string, newText: string): {
  diff: string;
  lines_added: number;
  lines_removed: number;
  is_identical: boolean;
} {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Quick check for identical content
  if (oldText === newText) {
    return {
      diff: '(No changes)',
      lines_added: 0,
      lines_removed: 0,
      is_identical: true,
    };
  }

  const dp = lcs(oldLines, newLines);
  const diffLines = backtrack(dp, oldLines, newLines, oldLines.length, newLines.length);

  let linesAdded = 0;
  let linesRemoved = 0;
  const diffOutput: string[] = [];

  // Format as unified diff
  diffOutput.push(`--- old`);
  diffOutput.push(`+++ new`);
  diffOutput.push('');

  for (const line of diffLines) {
    switch (line.type) {
      case 'unchanged':
        diffOutput.push(`  ${line.content}`);
        break;
      case 'added':
        diffOutput.push(`+ ${line.content}`);
        linesAdded++;
        break;
      case 'removed':
        diffOutput.push(`- ${line.content}`);
        linesRemoved++;
        break;
    }
  }

  return {
    diff: diffOutput.join('\n'),
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    is_identical: false,
  };
}

/**
 * Compare two backups by ID
 */
export function compareBackups(
  backupIdOld: string,
  backupIdNew: string | 'current',
  currentDefinition?: string
): DiffResult | null {
  const oldBackup = getBackupById(backupIdOld);
  if (!oldBackup) {
    return null;
  }

  const oldContent = getBackupContent(backupIdOld);
  if (!oldContent) {
    return null;
  }

  let newContent: string;
  let newBackupInfo: { backup_id: string | 'current'; timestamp: string };

  if (backupIdNew === 'current') {
    if (!currentDefinition) {
      return null;
    }
    newContent = currentDefinition;
    newBackupInfo = {
      backup_id: 'current',
      timestamp: new Date().toISOString(),
    };
  } else {
    const newBackup = getBackupById(backupIdNew);
    if (!newBackup) {
      return null;
    }
    const newBackupContent = getBackupContent(backupIdNew);
    if (!newBackupContent) {
      return null;
    }
    newContent = extractDefinitionFromBackup(newBackupContent);
    newBackupInfo = {
      backup_id: newBackup.id,
      timestamp: newBackup.timestamp,
    };
  }

  const oldDefinition = extractDefinitionFromBackup(oldContent);
  const { diff, lines_added, lines_removed, is_identical } = generateDiff(oldDefinition, newContent);

  return {
    object_name: oldBackup.object_name,
    old_version: {
      backup_id: oldBackup.id,
      timestamp: oldBackup.timestamp,
    },
    new_version: newBackupInfo,
    diff,
    lines_added,
    lines_removed,
    is_identical,
  };
}

/**
 * Generate a summary of changes
 */
export function generateChangeSummary(diffResult: DiffResult): string {
  if (diffResult.is_identical) {
    return `No changes between versions of ${diffResult.object_name}`;
  }

  const parts: string[] = [];
  parts.push(`Changes in ${diffResult.object_name}:`);
  parts.push(`  Old version: ${diffResult.old_version.backup_id} (${diffResult.old_version.timestamp})`);
  parts.push(`  New version: ${diffResult.new_version.backup_id} (${diffResult.new_version.timestamp})`);
  parts.push(`  Lines added: ${diffResult.lines_added}`);
  parts.push(`  Lines removed: ${diffResult.lines_removed}`);

  return parts.join('\n');
}

/**
 * Get context around a specific line in the diff
 */
export function getDiffContext(
  diff: string,
  lineNumber: number,
  contextLines: number = 3
): string {
  const lines = diff.split('\n');
  const start = Math.max(0, lineNumber - contextLines);
  const end = Math.min(lines.length, lineNumber + contextLines + 1);

  return lines.slice(start, end).join('\n');
}
