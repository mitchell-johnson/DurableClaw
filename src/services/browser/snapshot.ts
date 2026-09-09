/** Runs in the remote page. Return bounded, serializable data, never DOM nodes. */
export function readPageDocument(offset: number, limit: number) {
  const text = document.body?.innerText ?? "";
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 50)
    .map((element) => ({
      text: (element.textContent ?? "").trim().slice(0, 160),
      url: (element as HTMLAnchorElement).href.slice(0, 2000),
    }));
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    text: text.slice(offset, offset + limit),
    next_offset: text.length > offset + limit ? offset + limit : null,
    links,
  };
}
