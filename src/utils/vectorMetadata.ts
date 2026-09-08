/** Keep Vectorize metadata below its byte limit without shortening scope or record identity. */
export function fitVectorMetadata(
  input: Record<string, VectorizeVectorMetadata>,
  maxBytes = 9000,
): Record<string, VectorizeVectorMetadata> {
  const metadata = { ...input };
  const bytes = () =>
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
  while (bytes() > maxBytes) {
    const field = ["content_preview", "text"].find(
      (key) =>
        typeof metadata[key] === "string" &&
        (metadata[key] as string).length > 0,
    );
    if (field) {
      const value = metadata[field] as string;
      metadata[field] = Array.from(value)
        .slice(0, Math.floor(Array.from(value).length / 2))
        .join("");
      continue;
    }
    if (metadata.extra_json !== undefined) {
      delete metadata.extra_json;
      continue;
    }
    throw new Error("Vector metadata identity exceeds the size limit");
  }
  return metadata;
}
