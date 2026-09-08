/** In-memory R2 adapter with paginated listing and immutable read snapshots. */
export function createMemoryBucket(pageSize = 1000) {
  const objects = new Map<string, string>();
  return {
    objects,
    async put(key: string, body: string) {
      objects.set(key, body);
      return { key };
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : { key, text: async () => value, json: async () => JSON.parse(value) };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys])
        objects.delete(key);
    },
    async list(options: { prefix: string; cursor?: string }) {
      const all = [...objects.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .sort();
      const offset = Number(options.cursor ?? "0");
      const keys = all.slice(offset, offset + pageSize);
      const truncated = offset + keys.length < all.length;
      return {
        objects: keys.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(offset + keys.length) } : {}),
      };
    },
  };
}
