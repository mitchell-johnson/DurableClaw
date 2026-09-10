import type { Command, Data, HandlerMap, Runtime } from "./types";
import { segment, required } from "./types";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const me = "users/me";
export const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
const values = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);
export function encode64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    value += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(value);
}
export function decode64(v: string): Uint8Array {
  return Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
const url64 = (v: Uint8Array) =>
  encode64(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function messageId(v: string): string {
  return segment(
    required(v, "message ID").replace(
      /^(?:https:\/\/mail\.google\.com\/.*\/|#)/,
      "",
    ),
  );
}
export async function pages(
  r: Runtime,
  api: string,
  path: string,
  field: string,
  flags: Data,
  query: Data = {},
  options: Data = {},
): Promise<Data> {
  const items: Data[] = [];
  let pageToken = flags.page || undefined;
  let response: Data;
  const seen = new Set<string>();
  do {
    if (pageToken && seen.has(pageToken))
      throw new Error("Provider repeated a page token");
    if (pageToken) seen.add(pageToken);
    response = await r.json(api, path, {
      ...options,
      query: { ...query, ...(pageToken ? { pageToken } : {}) },
    });
    items.push(...(response[field] ?? []));
    pageToken = response.nextPageToken;
  } while ((flags.all || flags["all-pages"]) && pageToken);
  if (flags["fail-empty"] && !items.length) throw new Error("No results");
  return {
    ...response!,
    [field]: items,
    ...(pageToken ? { nextPageToken: pageToken } : {}),
  };
}
function headers(payload: Data = {}): Data {
  const result: Data = {};
  for (const h of payload.headers ?? [])
    result[String(h.name).toLowerCase().replace(/-/g, "_")] = h.value;
  return result;
}
function parts(payload: Data = {}): Data[] {
  return [payload, ...(payload.parts ?? []).flatMap(parts)];
}
function bodyText(payload: Data = {}, html = false): string {
  const all = parts(payload);
  const body =
    all.find(
      (p) => p.mimeType === (html ? "text/html" : "text/plain") && p.body?.data,
    ) ?? all.find((p) => p.mimeType?.startsWith("text/") && p.body?.data);
  const value = body ? decoder.decode(decode64(body.body.data)) : "";
  return !html &&
    (body?.mimeType === "text/html" || /<(?:html|body|p|div|br)\b/i.test(value))
    ? sanitize(value, false)
    : value;
}
function sanitize(v: string, stripLinks = true): string {
  const text = v
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .trim();
  return stripLinks ? text.replace(/https?:\/\/[^\s<>"']+/gi, "") : text;
}
function attachmentParts(payload: Data = {}): Data[] {
  return parts(payload).filter(
    (p) => p.filename && (p.body?.attachmentId || p.body?.data),
  );
}
function attachments(payload: Data = {}, indexed = false): Data[] {
  return attachmentParts(payload).map((p, i) => ({
    attachmentId: indexed ? String(i) : p.body.attachmentId,
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.body.size,
  }));
}
function safeName(v: string): string {
  return (
    v.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_") || "attachment"
  );
}
function strippedMessage(
  msg: Data,
  includeBody: boolean,
  indexed = false,
): Data {
  const h = headers(msg.payload);
  const clean: Data = {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: sanitize(msg.snippet ?? ""),
    headers: Object.fromEntries(
      Object.entries(h).map(([k, v]) => [k, sanitize(String(v))]),
    ),
    attachments: attachments(msg.payload, indexed),
  };
  if (includeBody) clean.body = sanitize(bodyText(msg.payload));
  return clean;
}
async function getMessage(c: Command, r: Runtime): Promise<Data> {
  const f = c.flags,
    format = f.format ?? "full";
  if (
    !["full", "metadata", "raw"].includes(format) ||
    (format === "raw" && f["sanitize-content"])
  )
    throw new Error("Invalid message format");
  const msg = await r.json(
    "gmail",
    `${me}/messages/${messageId(c.positionals[0])}`,
    {
      query: {
        format,
        ...(format === "metadata"
          ? {
              metadataHeaders: [
                ...new Set([
                  ...list(
                    f.headers ||
                      "From,To,Cc,Bcc,Subject,Date,Message-ID,Reply-To",
                  ),
                  "List-Unsubscribe",
                ]),
              ],
            }
          : {}),
      },
    },
  );
  if (f["sanitize-content"])
    return {
      message: strippedMessage(
        msg,
        format === "full",
        f["use-indexed-attachment-ids"],
      ),
    };
  const a = attachments(msg.payload, f["use-indexed-attachment-ids"]);
  if (f["use-indexed-attachment-ids"])
    for (const p of parts(msg.payload)) if (p.body) delete p.body.attachmentId;
  return {
    message: msg,
    headers: headers(msg.payload),
    ...(format === "full" ? { body: bodyText(msg.payload) } : {}),
    ...(a.length ? { attachments: a } : {}),
  };
}
async function attachmentBytes(
  r: Runtime,
  mid: string,
  part: Data,
): Promise<Uint8Array> {
  return decode64(
    part.body.data ??
      (
        await r.json(
          "gmail",
          `${me}/messages/${messageId(mid)}/attachments/${segment(part.body.attachmentId)}`,
        )
      ).data,
  );
}
async function downloadAttachments(
  c: Command,
  r: Runtime,
  messages: Data[],
): Promise<Data[]> {
  const output: Data[] = [];
  for (const msg of messages)
    for (const [i, part] of attachmentParts(msg.payload).entries()) {
      const name = `${
        c.flags["out-dir"]
          ? String(c.flags["out-dir"])
              .replace(/^output:/, "")
              .replace(/\/$/, "") + "/"
          : ""
      }${safeName(msg.id)}_${i}_${safeName(part.filename)}`;
      output.push({
        messageId: msg.id,
        attachmentId: c.flags["use-indexed-attachment-ids"]
          ? String(i)
          : part.body.attachmentId,
        filename: part.filename,
        ...r.output(name, await attachmentBytes(r, msg.id, part)),
      });
    }
  return output;
}
async function getThread(c: Command, r: Runtime): Promise<Data> {
  const thread = await r.json(
    "gmail",
    `${me}/threads/${messageId(c.positionals[0])}`,
    { query: { format: "full" } },
  );
  const files = c.flags.download
    ? await downloadAttachments(c, r, thread.messages ?? [])
    : undefined;
  if (c.command === "gmail.thread.attachments")
    return {
      threadId: thread.id,
      attachments: (thread.messages ?? []).flatMap((m: Data) =>
        attachments(m.payload, c.flags["use-indexed-attachment-ids"]).map(
          (a) => ({ messageId: m.id, ...a }),
        ),
      ),
      ...(files ? { files } : {}),
    };
  if (c.flags["sanitize-content"])
    return {
      thread: {
        id: thread.id,
        historyId: thread.historyId,
        messages: (thread.messages ?? []).map((m: Data) =>
          strippedMessage(
            m,
            !!c.flags.full,
            c.flags["use-indexed-attachment-ids"],
          ),
        ),
      },
      ...(files ? { files } : {}),
    };
  if (c.flags["use-indexed-attachment-ids"])
    for (const m of thread.messages ?? [])
      for (const p of parts(m.payload)) if (p.body) delete p.body.attachmentId;
  return { thread, ...(files ? { files } : {}) };
}
const systemLabels = new Set([
  "INBOX",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
async function resolveLabels(
  r: Runtime,
  names: string[],
  create = false,
): Promise<string[]> {
  if (!names.some((name) => !systemLabels.has(name) && !/^Label_/.test(name)))
    return names;
  const { labels = [] } = await r.json("gmail", `${me}/labels`);
  const result: string[] = [];
  for (const name of names) {
    if (systemLabels.has(name) || /^Label_/.test(name)) {
      result.push(name);
      continue;
    }
    const label = labels.find((l: Data) => l.id === name || l.name === name);
    if (label) result.push(label.id);
    else if (create)
      result.push(
        (
          await r.json("gmail", `${me}/labels`, {
            method: "POST",
            body: {
              name,
              labelListVisibility: "labelShow",
              messageListVisibility: "show",
            },
          })
        ).id,
      );
    else throw new Error(`Label not found: ${name}`);
  }
  return result;
}
async function labelChanges(
  r: Runtime,
  add: unknown,
  remove: unknown,
): Promise<Data> {
  const a = list(add),
    b = list(remove),
    ids = await resolveLabels(r, [...a, ...b]);
  return {
    addLabelIds: ids.slice(0, a.length),
    removeLabelIds: ids.slice(a.length),
  };
}
async function searchMail(c: Command, r: Runtime): Promise<Data> {
  const f = c.flags;
  if (f["body-format"] && !["text", "html"].includes(f["body-format"]))
    throw new Error("Body format must be text or html");
  let query = c.positionals.join(" ");
  if (f["from-contact"]) {
    const contacts = await r.json("people", "people:searchContacts", {
      query: {
        query: f["from-contact"],
        readMask: "emailAddresses",
        pageSize: 30,
      },
    });
    const emails = (contacts.results ?? []).flatMap((p: Data) =>
      (p.person?.emailAddresses ?? []).map((e: Data) => e.value),
    );
    if (!emails.length) throw new Error("Contact has no email addresses");
    query =
      `${query} {${emails.map((e: string) => `from:${e}`).join(" ")}}`.trim();
  }
  if (!query.trim()) throw new Error("Search query is required");
  const field = c.command === "gmail.search" ? "threads" : "messages";
  const result = await pages(
    r,
    "gmail",
    `${me}/${field}`,
    field,
    { ...f, all: f.all || f.count },
    { q: query, maxResults: f.max ?? 10 },
  );
  if (f.count) return { query, count: result[field].length };
  const results: Data[] = [];
  for (const item of result[field]) {
    const raw = await r.json("gmail", `${me}/${field}/${segment(item.id)}`, {
      query: { format: "full" },
    });
    const msg =
      field === "threads"
        ? f.oldest
          ? raw.messages?.[0]
          : raw.messages?.at(-1)
        : raw;
    if (!msg) continue;
    const h = headers(msg.payload);
    const date = new Date(Number(msg.internalDate));
    const formattedDate = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: f.timezone || (f.local ? undefined : "UTC"),
          dateStyle: "short",
          timeStyle: "short",
        }).format(date)
      : h.date;
    const messageAttachments = attachments(
      msg.payload,
      f["use-indexed-attachment-ids"],
    );
    if (f["use-indexed-attachment-ids"])
      for (const part of parts(msg.payload))
        if (part.body) delete part.body.attachmentId;
    results.push({
      id: item.id,
      threadId: msg.threadId,
      date: formattedDate,
      from: h.from,
      subject: h.subject,
      labels: msg.labelIds,
      ...(field === "threads" ? { messageCount: raw.messages?.length } : {}),
      ...(f["include-body"]
        ? { body: bodyText(msg.payload, f["body-format"] === "html") }
        : {}),
      ...(f["include-attachments"]
        ? {
            attachments: messageAttachments,
          }
        : {}),
      ...(f.full ? { message: msg } : {}),
    });
  }
  return { [field]: results, nextPageToken: result.nextPageToken };
}
function header(v: unknown): string {
  const text = String(v ?? "");
  if (/[\r\n\0]/.test(text) || text.length > 16384)
    throw new Error("Invalid mail header");
  return /[^\x20-\x7e]/.test(text)
    ? `=?UTF-8?B?${encode64(encoder.encode(text))}?=`
    : text;
}
function mailboxHeader(v: unknown): string {
  const text = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  if (/[\r\n\0]/.test(text) || text.length > 16384)
    throw new Error("Invalid mail header");
  // RFC 2047 applies to display names, never the mailbox address or separators.
  const value = text.replace(
    /(?:"(?:[^"\\]|\\.)*"|[^,<>]+)\s*<[^<>]+>/g,
    (mailbox) => {
      const boundary = mailbox.lastIndexOf("<"),
        name = mailbox.slice(0, boundary).trim(),
        address = mailbox.slice(boundary);
      return /[^\x20-\x7e]/.test(name)
        ? `${header(name.replace(/^"|"$/g, ""))} ${address}`
        : mailbox;
    },
  );
  if (/[^\x20-\x7e]/.test(value))
    throw new Error("International mailboxes require an ASCII email address");
  return value;
}
function addresses(v: unknown): string[] {
  return (
    (Array.isArray(v) ? v.join(",") : String(v ?? "")).match(
      /[A-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Z0-9.-]+/gi,
    ) ?? []
  );
}
function bodyInput(f: Data, key: string, r: Runtime): string {
  if (f[key] !== undefined && f[`${key}-file`] !== undefined)
    throw new Error(`Use either ${key} or ${key}-file`);
  return f[`${key}-file`] ? r.text(f[`${key}-file`]) : String(f[key] ?? "");
}
function encodedPart(text: string, type: string): string {
  return `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${
    encode64(encoder.encode(text))
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  }`;
}
const mimeFor = (name: string) =>
  ({
    pdf: "application/pdf",
    txt: "text/plain",
    html: "text/html",
    json: "application/json",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    ics: "text/calendar",
  })[name.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream";
async function compose(c: Command, r: Runtime, existing?: Data): Promise<Data> {
  const f: Data = { ...c.flags };
  if (f.track || f["track-split"])
    throw new Error(
      "Mail tracking requires a separately configured tracking service",
    );
  let original: Data | undefined;
  const reply = c.command.includes("reply"),
    forward = c.command.endsWith("forward");
  const originalId =
    reply || forward ? c.positionals[0] : f["reply-to-message-id"];
  if (originalId && f["thread-id"])
    throw new Error("Use only one reply message or thread ID");
  if (f["clear-reply-context"] && (originalId || f["thread-id"] || f.quote))
    throw new Error("Cannot clear and set reply context together");
  if (f["clear-attachments"] && values(f.attach).length)
    throw new Error("Cannot supply and clear attachments together");
  if (originalId)
    original = await r.json(
      "gmail",
      `${me}/messages/${messageId(originalId)}`,
      { query: { format: "full" } },
    );
  const contextThread =
    f["thread-id"] ||
    (!f["clear-reply-context"] && f.quote ? existing?.threadId : undefined);
  if (!original && contextThread) {
    const thread = await r.json(
      "gmail",
      `${me}/threads/${messageId(contextThread)}`,
      {
        query: { format: "full" },
      },
    );
    const eligible = (thread.messages ?? []).filter(
      (message: Data) =>
        !(message.labelIds ?? []).includes("DRAFT") &&
        message.id !== existing?.id &&
        !(
          existing &&
          f.quote &&
          addresses(headers(message.payload).from).some(
            (email) => email.toLowerCase() === r.account.toLowerCase(),
          )
        ),
    );
    original = eligible.reduce(
      (latest: Data | undefined, message: Data) =>
        !latest ||
        Number(message.internalDate ?? 0) > Number(latest.internalDate ?? 0)
          ? message
          : latest,
      undefined,
    );
    if (!original)
      throw new Error("Thread has no delivered message to reply to");
    original = {
      ...original,
      threadId: original.threadId || thread.id || contextThread,
    };
  }
  if (original && !forward && (original.labelIds ?? []).includes("DRAFT"))
    throw new Error("Cannot reply to an unsent draft");
  if (f["reply-all"] && !original)
    throw new Error("Reply-all requires a reply message or thread ID");
  const previous = headers(existing?.payload),
    context = headers(original?.payload);
  let text = bodyInput(f, forward ? "note" : "body", r),
    html = bodyInput(f, "body-html", r);
  if (existing && f.body === undefined && f["body-file"] === undefined && !html)
    text = bodyText(existing.payload);
  let to = f.to ?? previous.to ?? "",
    cc = f.cc ?? previous.cc ?? "",
    bcc = f.bcc ?? previous.bcc ?? "";
  let subject = f.subject ?? previous.subject ?? "";
  const excluded = new Set([
    ...(!f["allow-self"] ? [r.account.toLowerCase()] : []),
    ...addresses(f.remove).map((v) => v.toLowerCase()),
  ]);
  if (original && !forward) {
    const replyAll = c.command.endsWith("reply-all") || f["reply-all"];
    let recipients: Data = {
      to: [
        ...addresses(context.reply_to || context.from),
        ...(replyAll ? addresses(context.to) : []),
      ],
      cc: replyAll ? addresses(context.cc) : [],
      bcc: [],
    };
    if (reply) {
      for (const key of ["to", "cc", "bcc"])
        for (const email of addresses(f[key])) {
          for (const other of ["to", "cc", "bcc"])
            recipients[other] = recipients[other].filter(
              (v: string) => v.toLowerCase() !== email.toLowerCase(),
            );
          recipients[key].push(email);
        }
      for (const key of ["to", "cc", "bcc"])
        recipients[key] = [...new Set(recipients[key] as string[])].filter(
          (a) => !excluded.has(a.toLowerCase()),
        );
      to = recipients.to.join(", ");
      cc = recipients.cc.join(", ");
      bcc = recipients.bcc.join(", ");
    } else {
      if (!f.to)
        to = recipients.to
          .filter((a: string) => !excluded.has(a.toLowerCase()))
          .join(", ");
      if (!f.cc)
        cc = recipients.cc
          .filter((a: string) => !excluded.has(a.toLowerCase()))
          .join(", ");
    }
    if (!subject)
      subject = /^re:/i.test(context.subject ?? "")
        ? context.subject
        : `Re: ${context.subject ?? ""}`;
    if ((reply && !f["no-quote"]) || f.quote)
      text += `\n\nOn ${context.date ?? ""}, ${context.from ?? ""} wrote:\n${bodyText(
        original.payload,
      )
        .split(/\r?\n/)
        .map((line) => "> " + line)
        .join("\n")}`;
  }
  if (forward && original) {
    subject ||= /^fwd:/i.test(context.subject ?? "")
      ? context.subject
      : `Fwd: ${context.subject ?? ""}`;
    text += `\n\n---------- Forwarded message ---------\nFrom: ${context.from ?? ""}\nDate: ${context.date ?? ""}\nSubject: ${context.subject ?? ""}\nTo: ${context.to ?? ""}\n\n${bodyText(original.payload)}`;
  }
  let from = f.from || previous.from || r.account;
  let aliases: Data[] | undefined;
  const loadAliases = async (): Promise<Data[]> =>
    (aliases ??= (await r.json("gmail", `${me}/settings/sendAs`)).sendAs ?? []);
  if (f["auto-from-addressed-alias"] && original && !f.from) {
    const recipients = [...addresses(context.to), ...addresses(context.cc)].map(
      (v) => v.toLowerCase(),
    );
    const alias = (await loadAliases()).find(
      (a) =>
        a.verificationStatus === "accepted" &&
        recipients.includes(a.sendAsEmail.toLowerCase()),
    );
    if (alias) from = alias.sendAsEmail;
  }
  if (addresses(from).length !== 1)
    throw new Error("A single valid From address is required");
  if (
    addresses(from)[0].toLowerCase() !== r.account.toLowerCase() &&
    !(await loadAliases()).some(
      (a) =>
        a.sendAsEmail.toLowerCase() === addresses(from)[0].toLowerCase() &&
        a.verificationStatus === "accepted",
    )
  )
    throw new Error("From must be your account or a verified send-as alias");
  if (f["signature-file"] && (f.signature || f["signature-from"]))
    throw new Error("Use one signature source");
  let signature = f["signature-file"] ? r.text(f["signature-file"]) : "";
  if (f.signature || f["signature-from"]) {
    const alias = await r.json(
      "gmail",
      `${me}/settings/sendAs/${segment(f["signature-from"] || addresses(from)[0])}`,
    );
    signature = alias.signature ?? "";
  }
  if (signature) {
    if (text)
      text += `\n\n--\n${signature
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .trim()}`;
    if (html) html += `<div class="gmail_signature">${signature}</div>`;
  }
  if (
    !c.command.startsWith("gmail.drafts.") &&
    !addresses(to).length &&
    !addresses(cc).length &&
    !addresses(bcc).length
  )
    throw new Error("At least one recipient is required");
  const hs: Data = {
    From: from,
    To: to,
    Cc: cc,
    Bcc: bcc,
    Subject: subject,
    "Reply-To": f["reply-to"] ?? previous.reply_to,
  };
  if (f.__autoReply) {
    hs["Auto-Submitted"] = "auto-replied";
    hs["X-Auto-Response-Suppress"] = "All";
  }
  const changedSubject =
    reply &&
    f.subject !== undefined &&
    String(f.subject)
      .replace(/^(?:re:\s*)+/i, "")
      .trim() !==
      String(context.subject ?? "")
        .replace(/^(?:re:\s*)+/i, "")
        .trim();
  const newThread = !!f["clear-reply-context"] || forward || changedSubject;
  if (!newThread) {
    const replyId = context.message_id || previous.in_reply_to;
    if (replyId) hs["In-Reply-To"] = replyId;
    const refs = context.references
      ? `${context.references} ${replyId}`
      : replyId || previous.references;
    if (refs) hs.References = refs;
  }
  let body =
    html && text
      ? (() => {
          const boundary = `alt_${crypto.randomUUID()}`;
          return `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${encodedPart(text, "text/plain")}\r\n--${boundary}\r\n${encodedPart(html, "text/html")}\r\n--${boundary}--`;
        })()
      : encodedPart(html || text, html ? "text/html" : "text/plain");
  const files = values(f.attach).map((ref) => ({
    name: ref
      .replace(/^input:/, "")
      .split("/")
      .at(-1)!,
    bytes: r.input(ref),
    type: mimeFor(ref),
  }));
  if (
    (forward && !f["skip-attachments"]) ||
    (existing && !values(f.attach).length && !f["clear-attachments"])
  )
    for (const p of attachmentParts((forward ? original : existing)?.payload))
      files.push({
        name: p.filename,
        bytes: await attachmentBytes(r, (forward ? original : existing)!.id, p),
        type: p.mimeType,
      });
  if (files.length) {
    const boundary = `mixed_${crypto.randomUUID()}`;
    body =
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${body}` +
      files
        .map(
          (file) =>
            `\r\n--${boundary}\r\nContent-Type: ${header(file.type)}\r\nContent-Disposition: attachment; filename="${safeName(file.name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${
              encode64(file.bytes)
                .match(/.{1,76}/g)
                ?.join("\r\n") ?? ""
            }`,
        )
        .join("") +
      `\r\n--${boundary}--`;
  }
  const raw =
    Object.entries(hs)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(
        ([k, v]) =>
          `${k}: ${["From", "To", "Cc", "Bcc", "Reply-To"].includes(k) ? mailboxHeader(v) : header(v)}`,
      )
      .join("\r\n") + `\r\nMIME-Version: 1.0\r\n${body}\r\n`;
  const threadId = newThread
    ? undefined
    : f["thread-id"] || original?.threadId || existing?.threadId;
  return { raw: url64(encoder.encode(raw)), ...(threadId ? { threadId } : {}) };
}
async function sendMail(c: Command, r: Runtime): Promise<Data> {
  const draft = c.command.startsWith("gmail.drafts.");
  let existing: Data | undefined;
  if (c.command === "gmail.drafts.update")
    existing = (
      await r.json("gmail", `${me}/drafts/${segment(c.positionals[0])}`, {
        query: { format: "full" },
      })
    ).message;
  let message: Data;
  if (c.flags["raw-file"]) {
    if (
      Object.keys(c.flags).some(
        (k) => !["raw-file", "track", "track-split"].includes(k) && c.flags[k],
      )
    )
      throw new Error("Raw mail cannot be combined with compose flags");
    const bytes = r.input(c.flags["raw-file"]),
      raw = decoder.decode(bytes),
      h = raw.split(/\r?\n\r?\n/, 1)[0];
    const fromHeaders = [...h.matchAll(/^From:\s*(.*)$/gim)],
      from = fromHeaders[0]?.[1];
    if (!from || fromHeaders.length !== 1 || addresses(from).length !== 1)
      throw new Error("Raw mail must have one valid From header");
    if (addresses(from)[0].toLowerCase() !== r.account.toLowerCase()) {
      const aliases =
        (await r.json("gmail", `${me}/settings/sendAs`)).sendAs ?? [];
      if (
        !aliases.some(
          (alias: Data) =>
            alias.sendAsEmail?.toLowerCase() ===
              addresses(from)[0].toLowerCase() &&
            alias.verificationStatus === "accepted",
        )
      )
        throw new Error(
          "Raw mail From must be your account or a verified send-as alias",
        );
    }
    message = { raw: url64(bytes) };
  } else message = await compose(c, r, existing);
  if (draft)
    return {
      draft: await r.json(
        "gmail",
        `${me}/drafts${existing ? "/" + segment(c.positionals[0]) : ""}`,
        { method: existing ? "PUT" : "POST", body: { message } },
      ),
    };
  return {
    message: await r.json("gmail", `${me}/messages/send`, {
      method: "POST",
      body: message,
    }),
  };
}
async function mailboxAction(c: Command, r: Runtime): Promise<Data> {
  const action = c.command.split(".")[1];
  const ids = c.positionals;
  if (
    (!ids.length && !c.flags.query && !c.flags.thread) ||
    (ids.length && c.flags.query)
  )
    throw new Error("Supply message IDs, a thread, or a query");
  const found = c.flags.query
    ? ((
        await r.json("gmail", `${me}/messages`, {
          query: { q: c.flags.query, maxResults: c.flags.max ?? 100 },
        })
      ).messages ?? [])
    : ids.map((id) => ({ id }));
  const change: Data = {
    addLabelIds: action === "unread" ? ["UNREAD"] : [],
    removeLabelIds:
      action === "archive"
        ? ["INBOX"]
        : action === "mark-read"
          ? ["UNREAD"]
          : [],
  };
  if (c.flags.thread) {
    if (c.flags.query || !ids.length)
      throw new Error(
        "--thread requires positional thread IDs and cannot use --query",
      );
    const threads = [];
    for (const id of ids)
      threads.push(
        await r.json("gmail", `${me}/threads/${messageId(id)}/modify`, {
          method: "POST",
          body: change,
        }),
      );
    return { threads };
  }
  for (const item of found)
    await r.json(
      "gmail",
      `${me}/messages/${messageId(item.id)}/${action === "trash" ? "trash" : "modify"}`,
      { method: "POST", ...(action === "trash" ? {} : { body: change }) },
    );
  return {
    action,
    modified: found.length,
    messageIds: found.map((m: Data) => m.id),
  };
}
async function autoreply(c: Command, r: Runtime): Promise<Data> {
  const f = c.flags;
  if (!bodyInput(f, "body", r) && !f["body-html"])
    throw new Error("Reply body is required");
  const labelName = f.label ?? "AutoReplied",
    label = (await resolveLabels(r, [labelName], true))[0];
  const found = await r.json("gmail", `${me}/messages`, {
    query: { q: c.positionals.join(" "), maxResults: f.max ?? 20 },
  });
  const results: Data[] = [],
    seen = new Set<string>();
  for (const m of found.messages ?? []) {
    const msg = await r.json("gmail", `${me}/messages/${segment(m.id)}`, {
      query: { format: "full" },
    });
    const h = headers(msg.payload);
    let reason =
      (msg.labelIds ?? []).includes(label) || seen.has(msg.threadId)
        ? "already-replied"
        : !f["allow-self"] &&
            addresses(h.from).some(
              (a) => a.toLowerCase() === r.account.toLowerCase(),
            )
          ? "self"
          : f["skip-bulk"] !== false &&
              (h.list_id ||
                (h.auto_submitted && h.auto_submitted !== "no") ||
                /bulk|list|junk/i.test(h.precedence ?? ""))
            ? "bulk"
            : "";
    if (reason) {
      results.push({ action: "skipped", messageId: m.id, reason });
      continue;
    }
    // compose fetches the message again immediately before constructing its reply.
    const sent = await sendMail(
      {
        ...c,
        command: "gmail.reply",
        positionals: [m.id],
        flags: { ...f, "no-quote": true, __autoReply: true },
      },
      r,
    );
    await r.json("gmail", `${me}/threads/${segment(msg.threadId)}/modify`, {
      method: "POST",
      body: {
        addLabelIds: [label],
        removeLabelIds: [
          ...(f.archive ? ["INBOX"] : []),
          ...(f["mark-read"] ? ["UNREAD"] : []),
        ],
      },
    });
    seen.add(msg.threadId);
    results.push({
      action: "replied",
      messageId: m.id,
      threadId: msg.threadId,
      replyMessageId: sent.message.id,
    });
  }
  return {
    autoReply: {
      query: c.positionals.join(" "),
      label: labelName,
      matched: results.length,
      replied: results.filter((v) => v.action === "replied").length,
      skipped: results.filter((v) => v.action === "skipped").length,
      results,
    },
  };
}
async function settings(c: Command, r: Runtime): Promise<unknown> {
  const [, , group, verb] = c.command.split("."),
    f = c.flags,
    id = c.positionals[0];
  const base = `${me}/settings/${({ autoforward: "autoForwarding", forwarding: "forwardingAddresses", sendas: "sendAs" } as Data)[group] ?? group}`;
  if (group === "vacation") {
    if (verb === "get") return { vacation: await r.json("gmail", base) };
    if (f.enable && f.disable) throw new Error("Choose enable or disable");
    const old = await r.json("gmail", base),
      body: Data = { ...old };
    for (const [flag, key] of Object.entries({
      subject: "responseSubject",
      body: "responseBodyPlainText",
      "contacts-only": "restrictToContacts",
      "domain-only": "restrictToDomain",
    }))
      if (f[flag] !== undefined) body[key] = f[flag];
    if (f.enable || f.disable) body.enableAutoReply = !!f.enable;
    for (const flag of ["start", "end"])
      if (f[flag] !== undefined) {
        const date = Date.parse(f[flag]);
        if (!Number.isFinite(date)) throw new Error(`Invalid ${flag} date`);
        body[`${flag}Time`] = String(date);
      }
    return { vacation: await r.json("gmail", base, { method: "PUT", body }) };
  }
  if (group === "autoforward") {
    if (verb === "get") return { autoForwarding: await r.json("gmail", base) };
    if (f.enable && f.disable) throw new Error("Choose enable or disable");
    const body: Data = { ...(await r.json("gmail", base)) };
    if (f.email !== undefined) body.emailAddress = f.email;
    if (f.disposition !== undefined) body.disposition = f.disposition;
    if (f.enable || f.disable) body.enabled = !!f.enable;
    return {
      autoForwarding: await r.json("gmail", base, { method: "PUT", body }),
    };
  }
  if (group === "filters") {
    if (["list", "get"].includes(verb))
      return r.json("gmail", base + (verb === "get" ? "/" + segment(id) : ""));
    if (verb === "delete") {
      await r.json("gmail", `${base}/${segment(id)}`, { method: "DELETE" });
      return { deleted: id };
    }
    if (verb === "create") {
      const criteria: Data = {};
      for (const flag of ["from", "to", "subject", "query"])
        if (f[flag] !== undefined) criteria[flag] = f[flag];
      if (f["has-attachment"] !== undefined)
        criteria.hasAttachment = f["has-attachment"];
      const add = [
        ...list(f["add-label"]),
        ...(f.star ? ["STARRED"] : []),
        ...(f.important ? ["IMPORTANT"] : []),
        ...(f.trash ? ["TRASH"] : []),
      ];
      const remove = [
        ...list(f["remove-label"]),
        ...(f.archive ? ["INBOX"] : []),
        ...(f["mark-read"] ? ["UNREAD"] : []),
        ...(f["never-spam"] ? ["SPAM"] : []),
      ];
      const action = await labelChanges(r, add, remove);
      if (f.forward) action.forward = f.forward;
      if (!Object.keys(criteria).length)
        throw new Error("At least one filter criterion is required");
      return {
        filter: await r.json("gmail", base, {
          method: "POST",
          body: { criteria, action },
        }),
      };
    }
    const result = await r.json("gmail", base),
      format = f.format || "xml";
    if (!["xml", "json"].includes(format))
      throw new Error("Filter export format must be xml or json");
    const escape = (v: unknown) =>
      String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const labels = (await r.json("gmail", `${me}/labels`)).labels ?? [];
    const xml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:apps="http://schemas.google.com/apps/2006">${(
      result.filter ?? []
    )
      .map((filter: Data) => {
        const props: Data = { ...filter.criteria },
          action = filter.action ?? {};
        const add = action.addLabelIds ?? [],
          remove = action.removeLabelIds ?? [];
        if (remove.includes("INBOX")) props.shouldArchive = true;
        if (remove.includes("UNREAD")) props.shouldMarkAsRead = true;
        if (remove.includes("SPAM")) props.shouldNeverSpam = true;
        if (add.includes("STARRED")) props.shouldStar = true;
        if (add.includes("TRASH")) props.shouldTrash = true;
        if (add.includes("IMPORTANT")) props.shouldAlwaysMarkAsImportant = true;
        if (action.forward) props.forwardTo = action.forward;
        const names = add
          .filter((id: string) => !systemLabels.has(id))
          .map(
            (id: string) => labels.find((l: Data) => l.id === id)?.name ?? id,
          );
        if (names.length) props.label = names.join(",");
        return `<entry><category term="filter"/><title>Mail Filter</title><id>${escape(filter.id)}</id><content/>${Object.entries(
          props,
        )
          .map(
            ([name, value]) =>
              `<apps:property name="${escape(name)}" value="${escape(value)}"/>`,
          )
          .join("")}</entry>`;
      })
      .join("")}</feed>`;
    const content = format === "json" ? JSON.stringify(result, null, 2) : xml;
    return f.out
      ? {
          ...r.output(r.outputName(c, `gmail-filters.${format}`), content),
          filters: result.filter?.length ?? 0,
        }
      : { format, content };
  }
  if (verb === "list") return r.json("gmail", base);
  if (verb === "get") return r.json("gmail", `${base}/${segment(id)}`);
  if (["delete", "remove"].includes(verb)) {
    await r.json("gmail", `${base}/${segment(id)}`, { method: "DELETE" });
    return { deleted: id };
  }
  if (verb === "verify") {
    await r.json("gmail", `${base}/${segment(id)}/verify`, { method: "POST" });
    return { verified: id };
  }
  if (group === "delegates")
    return {
      delegate: await r.json("gmail", base, {
        method: "POST",
        body: { delegateEmail: id },
      }),
    };
  if (group === "forwarding")
    return {
      forwardingAddress: await r.json("gmail", base, {
        method: "POST",
        body: { forwardingEmail: id },
      }),
    };
  const body: Data =
    verb === "update"
      ? await r.json("gmail", `${base}/${segment(id)}`)
      : { sendAsEmail: id };
  for (const [flag, key] of Object.entries({
    "display-name": "displayName",
    "reply-to": "replyToAddress",
    signature: "signature",
    "treat-as-alias": "treatAsAlias",
    "make-default": "isDefault",
  }))
    if (
      f[flag] !== undefined &&
      (verb !== "update" || (c.suppliedFlags ?? Object.keys(f)).includes(flag))
    )
      body[key] = f[flag];
  return {
    sendAs: await r.json(
      "gmail",
      base + (verb === "update" ? "/" + segment(id) : ""),
      { method: verb === "update" ? "PUT" : "POST", body },
    ),
  };
}
async function labelCommand(c: Command, r: Runtime): Promise<unknown> {
  const verb = c.command.split(".")[2],
    f = c.flags;
  if (verb === "list") return r.json("gmail", `${me}/labels`);
  if (verb === "create")
    return {
      label: await r.json("gmail", `${me}/labels`, {
        method: "POST",
        body: {
          name: c.positionals[0],
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      }),
    };
  if (verb === "modify") return modify(c, r, "threads");
  const id = (await resolveLabels(r, [c.positionals[0]]))[0];
  if (verb === "get")
    return { label: await r.json("gmail", `${me}/labels/${segment(id)}`) };
  if (verb === "delete") {
    await r.json("gmail", `${me}/labels/${segment(id)}`, { method: "DELETE" });
    return { deleted: id };
  }
  const body: Data = verb === "rename" ? { name: c.positionals[1] } : {};
  if (f["background-color"] || f["text-color"]) {
    const old = await r.json("gmail", `${me}/labels/${segment(id)}`);
    body.color = {
      ...old.color,
      ...(f["background-color"]
        ? { backgroundColor: f["background-color"] }
        : {}),
      ...(f["text-color"] ? { textColor: f["text-color"] } : {}),
    };
  }
  if (f["label-list-visibility"] !== undefined)
    body.labelListVisibility = f["label-list-visibility"];
  if (f["message-list-visibility"] !== undefined)
    body.messageListVisibility = f["message-list-visibility"];
  return {
    label: await r.json("gmail", `${me}/labels/${segment(id)}`, {
      method: "PATCH",
      body,
    }),
  };
}
async function modify(c: Command, r: Runtime, kind: string): Promise<Data> {
  const body = await labelChanges(r, c.flags.add, c.flags.remove);
  const result = [];
  for (const id of c.positionals)
    result.push(
      await r.json("gmail", `${me}/${kind}/${messageId(id)}/modify`, {
        method: "POST",
        body,
      }),
    );
  return { [kind]: result };
}
export const mailHandlers: HandlerMap = {};
const register = (
  names: string[],
  handler: (c: Command, r: Runtime) => Promise<unknown>,
) => {
  for (const name of names) mailHandlers[`gmail.${name}`] = handler;
};
register(["get"], getMessage);
register(["raw"], async (c, r) =>
  r.json("gmail", `${me}/messages/${messageId(c.positionals[0])}`, {
    query: { format: c.flags.format ?? "full" },
  }),
);
register(["thread.get", "thread.attachments"], getThread);
register(["attachment"], async (c, r) => {
  let part: Data = {
    body: { attachmentId: c.positionals[1] },
    filename: c.flags.name || "attachment",
  };
  if (c.flags["use-indexed-attachment-ids"]) {
    const m = await r.json(
      "gmail",
      `${me}/messages/${messageId(c.positionals[0])}`,
      { query: { format: "full" } },
    );
    part = attachmentParts(m.payload)[Number(c.positionals[1])];
    if (!part) throw new Error("Attachment index not found");
  }
  const bytes = await attachmentBytes(r, c.positionals[0], part);
  if (c.flags.inline) {
    if (bytes.length > (c.flags["inline-max-bytes"] ?? 3145728))
      throw new Error("Attachment exceeds inline size limit");
    return {
      filename: c.flags.name || part.filename,
      mimeType: part.mimeType,
      size: bytes.length,
      data: encode64(bytes),
    };
  }
  return r.output(
    r.outputName(c, safeName(c.flags.name || part.filename)),
    bytes,
  );
});
register(["search", "messages.search"], searchMail);
register(
  [
    "send",
    "reply",
    "reply-all",
    "forward",
    "drafts.create",
    "drafts.update",
    "drafts.reply",
    "drafts.reply-all",
    "drafts.forward",
  ],
  sendMail,
);
register(["archive", "mark-read", "unread", "trash"], mailboxAction);
register(["autoreply"], autoreply);
register(["messages.modify"], (c, r) => modify(c, r, "messages"));
register(["thread.modify"], (c, r) => modify(c, r, "threads"));
register(["batch.modify"], async (c, r) => {
  const body = {
    ids: c.positionals,
    ...(await labelChanges(r, c.flags.add, c.flags.remove)),
  };
  await r.json("gmail", `${me}/messages/batchModify`, { method: "POST", body });
  return { modified: c.positionals.length };
});
register(["batch.delete"], async (c, r) => {
  await r.json("gmail", `${me}/messages/batchDelete`, {
    method: "POST",
    body: { ids: c.positionals },
  });
  return { deleted: c.positionals.length };
});
register(["history"], (c, r) =>
  pages(r, "gmail", `${me}/history`, "history", c.flags, {
    startHistoryId: required(c.flags.since, "since history ID"),
    maxResults: c.flags.max ?? 100,
  }),
);
register(["drafts.list"], (c, r) =>
  pages(r, "gmail", `${me}/drafts`, "drafts", c.flags, {
    maxResults: c.flags.max ?? 20,
  }),
);
register(["drafts.get"], async (c, r) => {
  const draft = await r.json(
    "gmail",
    `${me}/drafts/${segment(c.positionals[0])}`,
    { query: { format: "full" } },
  );
  const a = attachments(
    draft.message?.payload,
    c.flags["use-indexed-attachment-ids"],
  );
  const files = c.flags.download
    ? await downloadAttachments(c, r, [draft.message])
    : undefined;
  if (c.flags["use-indexed-attachment-ids"])
    for (const p of parts(draft.message?.payload))
      if (p.body) delete p.body.attachmentId;
  return { draft, attachments: a, ...(files ? { files } : {}) };
});
register(["drafts.delete"], async (c, r) => {
  await r.json("gmail", `${me}/drafts/${segment(c.positionals[0])}`, {
    method: "DELETE",
  });
  return { deleted: c.positionals[0] };
});
register(["drafts.send"], async (c, r) => ({
  message: await r.json("gmail", `${me}/drafts/send`, {
    method: "POST",
    body: { id: c.positionals[0] },
  }),
}));
register(["import"], async (c, r) => ({
  message: await r.json("gmail", `${me}/messages/import`, {
    method: "POST",
    query: {
      internalDateSource: c.flags["internal-date-source"] ?? "dateHeader",
      neverMarkSpam: !!c.flags["never-mark-spam"],
      processForCalendar: !!c.flags["process-for-calendar"],
    },
    body: {
      raw: url64(r.input(c.positionals[0])),
      labelIds: await resolveLabels(r, list(c.flags.label)),
    },
  }),
}));
register(["url"], async (c, r) => ({
  urls: c.positionals.map(
    (id) =>
      `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(r.account)}#all/${encodeURIComponent(id)}`,
  ),
}));
register(
  [
    "labels.create",
    "labels.delete",
    "labels.get",
    "labels.list",
    "labels.modify",
    "labels.rename",
    "labels.style",
  ],
  labelCommand,
);
register(
  [
    "settings.autoforward.get",
    "settings.autoforward.update",
    "settings.delegates.add",
    "settings.delegates.get",
    "settings.delegates.list",
    "settings.delegates.remove",
    "settings.filters.create",
    "settings.filters.delete",
    "settings.filters.export",
    "settings.filters.get",
    "settings.filters.list",
    "settings.forwarding.create",
    "settings.forwarding.delete",
    "settings.forwarding.get",
    "settings.forwarding.list",
    "settings.sendas.create",
    "settings.sendas.delete",
    "settings.sendas.get",
    "settings.sendas.list",
    "settings.sendas.update",
    "settings.sendas.verify",
    "settings.vacation.get",
    "settings.vacation.update",
  ],
  settings,
);
export async function gmailQuickRead(
  operation: string,
  args: Data,
  runtime: Runtime,
): Promise<unknown> {
  const c: Command = {
    command: "",
    positionals: [],
    flags: {},
    files: [],
    output_files: [],
  };
  if (operation === "gmail_get_message")
    return getMessage(
      {
        ...c,
        command: "gmail.get",
        positionals: [args.message_id],
        flags: { "sanitize-content": true },
      },
      runtime,
    );
  if (operation === "gmail_get_thread")
    return getThread(
      {
        ...c,
        command: "gmail.thread.get",
        positionals: [args.thread_id],
        flags: { "sanitize-content": true, full: false },
      },
      runtime,
    );
  if (operation === "gmail_search") {
    const result = await searchMail(
      {
        ...c,
        command: "gmail.messages.search",
        positionals: [args.query],
        flags: { max: args.max ?? 10 },
      },
      runtime,
    );
    return {
      ...result,
      messages: result.messages.map((m: Data) => ({
        ...m,
        from: sanitize(m.from ?? ""),
        subject: sanitize(m.subject ?? ""),
      })),
    };
  }
  throw new Error("Unsupported Gmail read operation");
}
