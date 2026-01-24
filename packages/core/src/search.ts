/**
 * Parameterized SQL fragment with values for safe query building
 */
export interface ParameterizedSQL {
  /** SQL fragment with $1, $2, etc. placeholders */
  sql: string;
  /** Values to bind to the placeholders */
  values: unknown[];
}

export interface SearchHelpers {
  /**
   * Build a tsvector from multiple text fields with optional weights
   * Weights: A (highest), B, C, D (lowest)
   * Returns parameterized SQL to prevent injection
   */
  buildTsvector(
    fields: Array<{ text: string | null; weight?: 'A' | 'B' | 'C' | 'D' }>,
    startIndex?: number
  ): ParameterizedSQL;

  /**
   * Build a tsquery from a search string using websearch_to_tsquery
   * This safely handles user input without SQL injection risk
   */
  buildTsquery(search: string, paramIndex?: number): ParameterizedSQL;

  /**
   * Generate SQL fragment for full-text search ranking
   */
  rankFragment(vectorColumn: string, queryParam: string): string;
}

/**
 * Validate that a string is a valid SQL identifier (table name, column name, etc.)
 * Only allows alphanumeric characters and underscores, must start with letter or underscore
 */
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Assert that all provided identifiers are valid SQL identifiers
 * @throws Error if any identifier is invalid
 */
function assertValidIdentifiers(
  identifiers: Record<string, string>
): void {
  for (const [label, value] of Object.entries(identifiers)) {
    if (!isValidIdentifier(value)) {
      throw new Error(
        `Invalid SQL identifier for ${label}: "${value}". ` +
          'Must contain only letters, numbers, and underscores, and start with a letter or underscore.'
      );
    }
  }
}

export function createSearchHelpers(): SearchHelpers {
  return {
    buildTsvector(fields, startIndex = 1) {
      const validFields = fields.filter((f) => f.text);

      if (validFields.length === 0) {
        return {
          sql: "to_tsvector('english', '')",
          values: [],
        };
      }

      const parts: string[] = [];
      const values: unknown[] = [];

      validFields.forEach((f, idx) => {
        const weight = f.weight || 'D';
        const paramNum = startIndex + idx;
        parts.push(
          `setweight(to_tsvector('english', COALESCE($${paramNum}, '')), '${weight}')`
        );
        values.push(f.text);
      });

      return {
        sql: parts.join(' || '),
        values,
      };
    },

    buildTsquery(search, paramIndex = 1) {
      const trimmed = search.trim();

      if (trimmed.length === 0) {
        return {
          sql: "''::tsquery",
          values: [],
        };
      }

      // Use websearch_to_tsquery which safely handles user input
      // and supports natural search syntax (AND, OR, quotes for phrases, - for NOT)
      return {
        sql: `websearch_to_tsquery('english', $${paramIndex})`,
        values: [trimmed],
      };
    },

    rankFragment(vectorColumn, queryParam) {
      return `ts_rank(${vectorColumn}, ${queryParam})`;
    },
  };
}

/**
 * Helper to create a search_vector column update trigger
 * Returns SQL statements to create the trigger
 * @throws Error if any identifier (table name, column names) is invalid
 */
export function createSearchTriggerSQL(
  tableName: string,
  vectorColumn: string,
  textColumns: Array<{ column: string; weight?: 'A' | 'B' | 'C' | 'D' }>
): string {
  // Validate all identifiers to prevent SQL injection
  assertValidIdentifiers({ tableName, vectorColumn });
  for (const col of textColumns) {
    assertValidIdentifiers({ column: col.column });
  }

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
