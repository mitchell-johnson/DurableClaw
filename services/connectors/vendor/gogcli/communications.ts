/** Google communication command ports from the pinned gogcli source. */
import type { HandlerMap } from "./types";
import { mailHandlers } from "./communications-mail";
import { peopleHandlers } from "./communications-people";
import { chatHandlers } from "./communications-chat";
import { calendarTaskMapHandlers } from "./communications-calendar";
export { gmailQuickRead } from "./communications-mail";
export const communicationHandlers: HandlerMap = {
  ...mailHandlers,
  ...peopleHandlers,
  ...chatHandlers,
  ...calendarTaskMapHandlers,
};
