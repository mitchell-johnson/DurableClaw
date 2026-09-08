/**
 * Group memory manager for persistent key-value storage.
 *
 * Wraps the SQLite group_memory table to provide a simple interface
 * for storing and retrieving per-conversation memories.
 */

interface MemoryRow extends Record<string, SqlStorageValue> {
  key: string;
  value: string;
  updated_at: number;
}

export class GroupMemory {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /**
   * Retrieve a single value by key.
   * Returns null if the key does not exist.
   */
  get(key: string): string | null {
    const rows = this.sql
      .exec<MemoryRow>("SELECT value FROM group_memory WHERE key = ?", key)
      .toArray();

    if (rows.length === 0) {
      return null;
    }
    return rows[0].value;
  }

  /**
   * Store a key-value pair, overwriting any existing value for the key.
   */
  set(key: string, value: string): void {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO group_memory (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      now,
    );
  }

  /**
   * Retrieve all stored memories as a flat key-value record.
   */
  getAll(): Record<string, string> {
    const rows = this.sql
      .exec<MemoryRow>("SELECT key, value FROM group_memory")
      .toArray();

    const result: Record<string, string> = Object.create(null);
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Delete a single key from memory.
   */
  delete(key: string): void {
    this.sql.exec("DELETE FROM group_memory WHERE key = ?", key);
  }

  /**
   * Build a formatted context string of all stored memories
   * suitable for injection into the system prompt.
   *
   * Returns an empty string if no memories exist.
   */
  getContext(): string {
    const all = this.getAll();
    const entries = Object.entries(all);

    if (entries.length === 0) {
      return "";
    }

    const lines = entries.map(([key, value]) => `- ${key}: ${value}`);
    return [
      "<group_memory>",
      "The following are persistent memories stored for this conversation:",
      ...lines,
      "</group_memory>",
    ].join("\n");
  }
}
