import type { HandlerMap } from "./types";
import { driveFileHandlers } from "./drive-files";
import { driveCollaborationHandlers } from "./drive-collaboration";
import { driveOtherHandlers } from "./drive-other";

export const driveHandlers: HandlerMap = {
  ...driveFileHandlers,
  ...driveCollaborationHandlers,
  ...driveOtherHandlers,
};
