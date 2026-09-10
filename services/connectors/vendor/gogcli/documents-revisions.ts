import type { Data, Handler, RequestOptions, Runtime } from "./types";

interface RevisionState {
  revision?: string;
  unknownAfterWrite: boolean;
}
const conflict = () =>
  new Error(
    "Document revision changed during this command; inspect the current document before retrying",
  );

/** Keep every snapshot in a command on one verified revision lineage. A GET
 * cannot bless positions computed from an older document. Only the revision
 * Google returns for our own successful batchUpdate advances that lineage. */
export function withDocumentRevisions(handler: Handler): Handler {
  return async (command, runtime) => {
    const documents = new Map<string, RevisionState>();
    const guarded = new Proxy(runtime, {
      get(target, key) {
        if (key !== "json") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (
          api: string,
          path: string,
          options: RequestOptions = {},
        ) => {
          const match =
            api === "docs"
              ? /^documents\/([^/:]+)(:batchUpdate)?$/.exec(path)
              : null;
          if (!match) return target.json(api, path, options);
          const document = match[1],
            previous = documents.get(document);
          const snapshot = !match[2] && (options.method ?? "GET") === "GET";
          const mutation =
            match[2] === ":batchUpdate" && options.method === "POST";
          if (!snapshot && !mutation) return target.json(api, path, options);
          if (previous?.unknownAfterWrite)
            throw new Error(
              "Google did not return a verified revision after the previous mutation; inspect the document before continuing",
            );
          if (snapshot) {
            const response = await target.json(api, path, options),
              revision =
                typeof response?.revisionId === "string" && response.revisionId
                  ? response.revisionId
                  : undefined;
            if (previous && revision !== previous.revision) throw conflict();
            documents.set(document, { revision, unknownAfterWrite: false });
            return response;
          }
          if (!previous?.revision)
            throw new Error(
              "A document revision is required before indexed mutations",
            );
          const body = options.body as Data | undefined,
            control = body?.writeControl;
          if (!body || !Array.isArray(body.requests))
            throw new Error("Invalid document mutation");
          if (
            control &&
            (control.requiredRevisionId !== previous.revision ||
              control.targetRevisionId !== undefined)
          )
            throw conflict();
          // Mark the lineage uncertain before dispatch, including provider failures.
          // A caught error must never permit dependent edits against a fresh snapshot.
          documents.set(document, { unknownAfterWrite: true });
          const response = await target.json(api, path, {
            ...options,
            body: {
              ...body,
              writeControl: { requiredRevisionId: previous.revision },
            },
          });
          const revision = response?.writeControl?.requiredRevisionId;
          documents.set(document, {
            revision:
              typeof revision === "string" && revision ? revision : undefined,
            unknownAfterWrite: typeof revision !== "string" || !revision,
          });
          return response;
        };
      },
    }) as Runtime;
    return handler(command, guarded);
  };
}
