/** Fixed destinations. User input cannot choose a server or supply credentials. */
export const API_BASES: Readonly<Record<string, string>> = {
  gmail: "https://gmail.googleapis.com/gmail/v1/",
  calendar: "https://www.googleapis.com/calendar/v3/",
  people: "https://people.googleapis.com/v1/",
  contacts: "https://people.googleapis.com/v1/",
  tasks: "https://tasks.googleapis.com/tasks/v1/",
  chat: "https://chat.googleapis.com/v1/",
  "chat-upload": "https://chat.googleapis.com/upload/v1/",
  maps: "https://maps.googleapis.com/maps/api/",
  places: "https://places.googleapis.com/v1/",
  docs: "https://docs.googleapis.com/v1/",
  sheets: "https://sheets.googleapis.com/v4/",
  slides: "https://slides.googleapis.com/v1/",
  drive: "https://www.googleapis.com/drive/v3/",
  "drive-upload": "https://www.googleapis.com/upload/drive/v3/",
  "drive-v2": "https://www.googleapis.com/drive/v2/",
  "drive-v2-upload": "https://www.googleapis.com/upload/drive/v2/",
  "docs-web": "https://docs.google.com/",
  driveactivity: "https://driveactivity.googleapis.com/v2/",
  drivelabels: "https://drivelabels.googleapis.com/v2/",
  photos: "https://photoslibrary.googleapis.com/v1/",
  photospicker: "https://photospicker.googleapis.com/v1/",
  forms: "https://forms.googleapis.com/v1/",
  meet: "https://meet.googleapis.com/v2/",
  appscript: "https://script.googleapis.com/v1/",
  admin: "https://admin.googleapis.com/admin/directory/v1/",
  classroom: "https://classroom.googleapis.com/v1/",
  youtube: "https://youtube.googleapis.com/youtube/v3/",
  "youtube-upload": "https://www.googleapis.com/upload/youtube/v3/",
  adsense: "https://adsense.googleapis.com/v2/",
  analyticsadmin: "https://analyticsadmin.googleapis.com/v1beta/",
  analyticsdata: "https://analyticsdata.googleapis.com/v1beta/",
  searchconsole: "https://www.googleapis.com/webmasters/v3/",
  searchconsoleinspection: "https://searchconsole.googleapis.com/v1/",
  groups: "https://cloudidentity.googleapis.com/v1/",
  keep: "https://keep.googleapis.com/v1/",
};
/** Check before URL construction: URL normalizes dots and can change the API method target. */
export function rejectDotSegments(path: string): void {
  let decoded = path.split(/[?#]/, 1)[0];
  for (let depth = 0; depth < 4; depth++) {
    if (decoded.split(/[\\/]/).some((part) => part === "." || part === ".."))
      throw new Error("Invalid API resource path");
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error("Invalid API resource encoding");
    }
    if (next === decoded) return;
    decoded = next;
  }
  throw new Error("Excessively encoded API resource path");
}
