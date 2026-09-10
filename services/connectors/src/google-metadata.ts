import manifest from "./google-services.json";
export const GOOGLE_SERVICES = manifest.services;
export const OIDC_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
export function normalizeScope(scope: string): string {
  return scope === "email"
    ? OIDC_SCOPES[1]
    : scope === "profile"
      ? OIDC_SCOPES[2]
      : scope;
}

// Upstream CLI defaults are narrower than its complete command/API surface.
// These additions are requested only when the user selects the corresponding service.
// https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
// https://developers.google.com/workspace/drive/labels/guides/authorize
// https://developers.google.com/photos/support/updates
// https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1alpha/accounts.accessBindings/create
// https://developers.google.com/workspace/sheets/api/guides/connected-sheets
const FULL_SERVICE_SCOPES: Record<string, readonly string[]> = {
  gmail: ["https://mail.google.com/"],
  sheets: ["https://www.googleapis.com/auth/bigquery.readonly"],
  admin: ["https://www.googleapis.com/auth/admin.directory.orgunit"],
  youtube: [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ],
  drivelabels: [
    "https://www.googleapis.com/auth/drive.labels",
    "https://www.googleapis.com/auth/drive.admin.labels",
  ],
  photos: [
    "https://www.googleapis.com/auth/photoslibrary.appendonly",
    "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
  ],
  analytics: [
    "https://www.googleapis.com/auth/analytics.edit",
    "https://www.googleapis.com/auth/analytics.manage.users",
  ],
};

export const PUBLIC_GOOGLE_SERVICES = [
  ...GOOGLE_SERVICES.map((service) => ({
    ...service,
    scopes: [
      ...new Set(
        service.scopes
          .map(normalizeScope)
          .concat(FULL_SERVICE_SCOPES[service.service] ?? []),
      ),
    ],
    authorization:
      service.service === "keep" ? "workspace-delegation" : "oauth",
    ...(service.service === "gmail"
      ? {
          note: "Read and manage mail; contact-name search also needs Contacts. Delegates, forwarding changes and nonprimary send-as changes require optional Workspace delegation. The sharing scope is delegated only.",
        }
      : {}),
    ...(service.service === "calendar"
      ? {
          note: "Read and manage calendars. Directory lookup also needs Contacts; team availability also needs Groups.",
        }
      : {}),
    ...(service.service === "people"
      ? { note: "Google profile access. Directory search also needs Contacts." }
      : {}),
    ...(service.service === "sheets"
      ? {
          note: "Read and manage spreadsheets, including BigQuery Connected Sheets. Connected data also requires an eligible billing project and BigQuery IAM access.",
        }
      : {}),
    ...(service.service === "photos"
      ? {
          note: "Read, upload and edit app-created media; Google restricts access to other library content.",
        }
      : {}),
    ...(service.service === "drivelabels"
      ? {
          note: "Read and manage labels; administrator operations require Workspace privileges.",
        }
      : {}),
    ...(service.service === "youtube"
      ? {
          note: "Read and manage your YouTube account; channel permissions still apply.",
        }
      : {}),
    ...(service.service === "analytics"
      ? {
          note: "Reporting, configuration and access management; Analytics account roles still apply.",
        }
      : {}),
  })),
  {
    service: "maps",
    user: false,
    scopes: [] as string[],
    apis: ["Google Maps Platform"],
    authorization: "api-key",
    note: "Requires an operator-configured Maps API key and enabled Places/Geocoding APIs; selected explicitly.",
  },
];
