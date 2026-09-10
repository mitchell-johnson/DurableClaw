import type { Command, Data, Handler, Runtime } from "./types";
import { NativeCleanupError, type CleanupWarning } from "./diagnostics";

/** Image uploads are private per invocation. Docs retain the source but revoke
 * temporary public permissions; Slides delete temporary sources after import. */
export function imageLifecycle(
  handler: Handler,
  mode: "docs" | "slides",
): Handler {
  return async (c, r) => {
    const assets: {
      fileId: string;
      permissionId?: string;
      public: boolean;
      revoked?: boolean;
      deleted?: boolean;
    }[] = [];
    const runtime = new Proxy(r, {
      get(target, key) {
        if (key === "upload")
          return async (...args: Parameters<Runtime["upload"]>) => {
            if (
              args[0] === "drive-upload" &&
              args[1] === "files" &&
              assets.length >= 8
            )
              throw new Error("An invocation can upload at most eight images");
            const result = await target.upload(...args);
            if (args[0] === "drive-upload" && args[1] === "files" && result.id)
              assets.push({ fileId: result.id, public: false });
            return result;
          };
        if (key === "json")
          return async (...args: Parameters<Runtime["json"]>) => {
            const asset = assets.find(
              (a) =>
                args[1] === `files/${encodeURIComponent(a.fileId)}/permissions`,
            );
            const sharing =
              asset &&
              args[2]?.method === "POST" &&
              (args[2].body as Data)?.type === "anyone";
            // A lost response cannot prove that permission creation failed.
            if (sharing) asset.public = true;
            try {
              const result = await target.json(...args);
              if (sharing) asset.permissionId = result.id;
              return result;
            } catch (error) {
              if (
                sharing &&
                error instanceof Error &&
                error.message === "Google request failed (403)"
              )
                asset.public = false;
              throw error;
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let output: unknown, failure: unknown;
    try {
      output = await handler(c, runtime);
    } catch (error) {
      failure = error;
    }
    const warnings: string[] = [];
    const cleanupRequired: CleanupWarning[] = [];
    const cleanup = async (fileId: string, permissionId?: string) => {
      const capability = (
        r as Runtime & {
          cleanupGoogleFile?: (
            fileId: string,
            permissionId?: string,
          ) => Promise<void>;
        }
      ).cleanupGoogleFile;
      if (capability) return capability.call(r, fileId, permissionId);
      await r.json(
        "drive",
        `files/${encodeURIComponent(fileId)}${permissionId ? `/permissions/${encodeURIComponent(permissionId)}` : ""}`,
        { method: "DELETE", query: { supportsAllDrives: true } },
      );
    };
    for (const asset of assets) {
      if (mode === "docs" && asset.public && asset.permissionId) {
        try {
          await cleanup(asset.fileId, asset.permissionId);
          asset.public = false;
          asset.revoked = true;
        } catch {
          /* Deleting our uploaded source remains a separate fallback. */
        }
      }
      if (mode === "slides" || failure || asset.public) {
        try {
          await cleanup(asset.fileId);
          asset.deleted = true;
          asset.public = false;
        } catch {
          /* Preserve a bounded diagnostic for owner recovery. */
        }
      }
      if (!asset.deleted && (mode === "slides" || failure || asset.public)) {
        cleanupRequired.push({
          file_id: asset.fileId,
          public_read_permission_may_remain: asset.public,
        });
        warnings.push(
          `Cleanup required for uploaded Drive file ${asset.fileId}${asset.public ? " (temporary public reader permission may remain)" : ""}`,
        );
      }
    }
    if (failure) {
      if (cleanupRequired.length) throw new NativeCleanupError(cleanupRequired);
      throw failure;
    }
    return {
      ...(output && typeof output === "object" ? output : { result: output }),
      ...(assets.length ? { assets } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(cleanupRequired.length ? { cleanup_required: cleanupRequired } : {}),
    };
  };
}
