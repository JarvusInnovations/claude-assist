import type postgres from 'postgres';

export interface SearchHelpers {
  /**
   * Build a tsvector from multiple text fields with optional weights
   * Weights: A (highest), B, C, D (lowest)
   */
  buildTsvector(fields: Array<{ text: string | null; weight?: 'A' | 'B' | 'C' | 'D' }>): string;

  /**
   * Build a tsquery from a search string
   * Supports AND (&), OR (|), NOT (!), and phrase matching
   */
  buildTsquery(search: string): string;

  /**
   * Generate SQL fragment for full-text search ranking
   */
  rankFragment(vectorColumn: string, queryParam: string): string;
}

export function createSearchHelpers(sql: postgres.Sql): SearchHelpers {
  return {
    buildTsvector(fields) {
      const parts = fields
        .filter((f) => f.text)
        .map((f) => {
          const weight = f.weight || 'D';
          // Escape single quotes in text
          const escaped = f.text!.replace(/'/g, "''");
          return `setweight(to_tsvector('english', '${escaped}'), '${weight}')`;
        });

      if (parts.length === 0) {
        return "to_tsvector('english', '')";
      }

      return parts.join(' || ');
    },

    buildTsquery(search) {
      // Simple tokenization: split on whitespace, join with &
      const tokens = search
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .map((t) => {
          // Handle special operators
          if (t.startsWith('-')) {
            return `!${t.slice(1)}:*`;
          }
          // Add prefix matching by default
          return `${t}:*`;
        });

      if (tokens.length === 0) {
        return "''::tsquery";
      }

      return `to_tsquery('english', '${tokens.join(' & ')}')`;
    },

    rankFragment(vectorColumn, queryParam) {
      return `ts_rank(${vectorColumn}, ${queryParam})`;
    },
  };
}

/**
 * Helper to create a search_vector column update trigger
 * Returns SQL statements to create the trigger
 */
export function createSearchTriggerSQL(
  tableName: string,
  vectorColumn: string,
  textColumns: Array<{ column: string; weight?: 'A' | 'B' | 'C' | 'D' }>
): string {
  const functionName = `${tableName}_search_vector_update`;
  const triggerName = `${tableName}_search_vector_trigger`;

  const vectorParts = textColumns
    .map((c) => {
      const weight = c.weight || 'D';
      return `setweight(to_tsvector('english', COALESCE(NEW.${c.column}, '')), '${weight}')`;
    })
    .join(' || ');

  return `
-- Create or replace the trigger function
CREATE OR REPLACE FUNCTION ${functionName}()
RETURNS TRIGGER AS $$
BEGIN
  NEW.${vectorColumn} := ${vectorParts};
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName};

-- Create the trigger
CREATE TRIGGER ${triggerName}
  BEFORE INSERT OR UPDATE ON ${tableName}
  FOR EACH ROW
  EXECUTE FUNCTION ${functionName}();
`.trim();
}
