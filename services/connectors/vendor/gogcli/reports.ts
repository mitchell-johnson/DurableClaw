import type { HandlerMap } from "./types";
import { dataReportHandlers, searchReportHandlers } from "./reports-data";
import { youtubeHandlers } from "./reports-youtube";

export const reportHandlers: HandlerMap = {
  ...dataReportHandlers,
  ...searchReportHandlers,
  ...youtubeHandlers,
};
