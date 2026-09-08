export interface WorkspaceFile {
  path: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}

export interface FileMetadata {
  size: number;
  lastModified: Date;
  contentType?: string;
  customMetadata: Record<string, string>;
  etag: string;
}

export class R2Workspace {
  constructor(
    private bucket: R2Bucket,
    private prefix: string,
  ) {}

  private key(path: string): string {
    return this.prefix + path;
  }

  private stripPrefix(key: string): string {
    return key.slice(this.prefix.length);
  }

  async listFiles(subPrefix?: string): Promise<WorkspaceFile[]> {
    const prefix = subPrefix ? this.key(subPrefix) : this.prefix;
    const files: WorkspaceFile[] = [];
    let cursor: string | undefined;

    do {
      const options: R2ListOptions = { prefix, cursor };
      const listed = await this.bucket.list(options);

      for (const object of listed.objects) {
        files.push({
          path: this.stripPrefix(object.key),
          size: object.size,
          lastModified: object.uploaded,
          contentType: object.httpMetadata?.contentType,
        });
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return files;
  }

  async readFile(path: string): Promise<string | null> {
    const object = await this.bucket.get(this.key(path));
    if (!object) {
      return null;
    }
    return object.text();
  }

  async readFileBytes(path: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(this.key(path));
    if (!object) {
      return null;
    }
    return object.arrayBuffer();
  }

  async writeFile(
    path: string,
    content: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.bucket.put(this.key(path), content, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: metadata,
    });
  }

  async writeFileBytes(
    path: string,
    data: ArrayBuffer | ReadableStream,
    contentType?: string,
  ): Promise<void> {
    await this.bucket.put(this.key(path), data, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  }

  async deleteFile(path: string): Promise<void> {
    await this.bucket.delete(this.key(path));
  }

  async exists(path: string): Promise<boolean> {
    const head = await this.bucket.head(this.key(path));
    return head !== null;
  }

  async getMetadata(path: string): Promise<FileMetadata | null> {
    const head = await this.bucket.head(this.key(path));
    if (!head) {
      return null;
    }
    return {
      size: head.size,
      lastModified: head.uploaded,
      contentType: head.httpMetadata?.contentType,
      customMetadata: head.customMetadata ?? {},
      etag: head.etag,
    };
  }

  async getSize(): Promise<number> {
    let totalSize = 0;
    let cursor: string | undefined;

    do {
      const options: R2ListOptions = { prefix: this.prefix, cursor };
      const listed = await this.bucket.list(options);

      for (const object of listed.objects) {
        totalSize += object.size;
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return totalSize;
  }
}
