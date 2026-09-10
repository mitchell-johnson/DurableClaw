import { withDocumentRevisions } from "./documents-revisions";
import { sheetHandlers } from "./documents-sheets";
import { slideHandlers } from "./documents-slides";
import { docHandlers } from "./documents-docs";
import { sedHandler } from "./documents-sed";
import type { HandlerMap } from "./types";
export const documentHandlers: HandlerMap = {
  ...sheetHandlers,
  ...slideHandlers,
  ...docHandlers,
  "docs.sed": sedHandler,
};

for (const [name, handler] of Object.entries(documentHandlers))
  if (name.startsWith("docs."))
    documentHandlers[name] = withDocumentRevisions(handler);
