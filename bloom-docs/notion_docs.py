"""Read and write pages of the Bloom docs site (docs.bloomlibrary.org) in Notion.

Run it as a command:

    py notion_docs.py dump <page>                 print a page's blocks as indented text
    py notion_docs.py props <page>                print a page's properties
    py notion_docs.py search <text>               find pages and databases by title
    py notion_docs.py create <title>              make a new page in the docs Database; prints its id
    py notion_docs.py set <page> Name=Value ...   set Database properties (see SKILL.md)
    py notion_docs.py write <page> <file.md>      replace a page's body with a markdown file
    py notion_docs.py link <outline-page> <page> [<after-block>]
                                                  add a link to <page> on an Outline page, at the
                                                  end or just after the block <after-block>

<page> is a page id, with or without dashes, or a Notion URL ending in one.

Or import it: `from notion_docs import api, md_to_blocks, rewrite`.

The token comes from SIL_BLOOM_DOCS_NOTION_TOKEN (a Notion personal access token; see
SKILL.md). On Windows, when the variable is not in this process's environment, it is
read from the User scope in the registry, because shells started before the variable
was set do not inherit it.
"""

import io, json, mimetypes, os, re, sys, time, urllib.error, urllib.request, uuid

BASE = "https://api.notion.com/v1/"
TOKEN_VAR = "SIL_BLOOM_DOCS_NOTION_TOKEN"
ROOT_PAGE = "043c6aa5842946bdbea3a4f37c97a0e7"
DATABASE = "915e28ea-feab-4970-a6c5-180d34a772e2"


def _token():
    """On Windows the User-scope value in the registry wins, because a shell started
    before the token was set or replaced still carries the old value."""
    if sys.platform == "win32":
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                return winreg.QueryValueEx(key, TOKEN_VAR)[0]
        except FileNotFoundError:
            pass
    return os.environ[TOKEN_VAR]


def _headers(content_type="application/json"):
    h = {"Authorization": "Bearer " + _token(), "Notion-Version": "2022-06-28"}
    if content_type:
        h["Content-Type"] = content_type
    return h


def api(method, path, body=None):
    """One JSON call to the Notion API. A failure raises with Notion's own message."""
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=_headers())
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        raise RuntimeError("%s %s -> %s %s" % (method, path, e.code, e.read().decode())) from None


def page_id(text):
    """The 32-hex id at the end of a Notion URL or id, with dashes removed."""
    m = re.search(r"([0-9a-f]{32})(?:[?#].*)?$", text.replace("-", ""))
    if not m:
        raise ValueError("No Notion page id in " + text)
    return m.group(1)


# ---------- rich text ----------

_INLINE = re.compile(
    r"\*\*(?P<bold>.+?)\*\*"
    r"|\*(?P<italic>[^*]+?)\*"
    r"|`(?P<code>[^`]+?)`"
    r"|\[(?P<text>[^\]]+?)\]\((?P<url>[^)]+?)\)"
)


def _run(content, bold=False, italic=False, code=False, url=None):
    text = {"content": content}
    if url:
        text["link"] = {"url": url}
    return {
        "type": "text",
        "text": text,
        "annotations": {"bold": bold, "italic": italic, "code": code},
    }


def rich(text):
    """Markdown inline text -> Notion rich text.

    Handles **bold**, *italic*, `code` and [text](url). A link to another docs page is
    written [text](notion:<page id>); it becomes an @mention of that page, which
    docu-notion turns into a link to the page's slug.
    """
    runs, pos = [], 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append(_run(text[pos : m.start()]))
        if m.group("bold"):
            runs.append(_run(m.group("bold"), bold=True))
        elif m.group("italic"):
            runs.append(_run(m.group("italic"), italic=True))
        elif m.group("code"):
            runs.append(_run(m.group("code"), code=True))
        elif m.group("url").startswith("notion:"):
            # The docs style is an @mention of the page, which shows the page's current
            # title (so the link text in the markdown is not used) and gives Notion backlinks.
            target = page_id(m.group("url")[len("notion:") :])
            runs.append({"type": "mention", "mention": {"type": "page", "page": {"id": target}}})
        else:
            runs.append(_run(m.group("text"), url=m.group("url")))
        pos = m.end()
    if pos < len(text):
        runs.append(_run(text[pos:]))
    return runs


def _block(kind, text, **extra):
    body = {"rich_text": rich(text)}
    body.update(extra)
    return {"object": "block", "type": kind, kind: body}


# ---------- images ----------


def upload(path):
    """Upload one local file and return its file_upload id."""
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    fid = api("POST", "file_uploads", {"filename": name, "content_type": ctype})["id"]

    boundary = "----notion" + uuid.uuid4().hex
    body = io.BytesIO()
    body.write(("--" + boundary + "\r\n").encode())
    body.write(('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % name).encode())
    body.write(("Content-Type: %s\r\n\r\n" % ctype).encode())
    with open(path, "rb") as f:
        body.write(f.read())
    body.write(("\r\n--" + boundary + "--\r\n").encode())

    r = urllib.request.Request(
        BASE + "file_uploads/" + fid + "/send",
        data=body.getvalue(),
        method="POST",
        headers=_headers("multipart/form-data; boundary=" + boundary),
    )
    sent = json.load(urllib.request.urlopen(r))
    assert sent["status"] == "uploaded", sent
    return fid


def image(path, caption=""):
    """An image block holding a local file. The caption stays empty unless given,
    because docu-notion reads a caption that starts with a language code as a
    localized replacement image."""
    return {
        "object": "block",
        "type": "image",
        "image": {
            "type": "file_upload",
            "file_upload": {"id": upload(path)},
            "caption": rich(caption) if caption else [],
        },
    }


# ---------- markdown -> blocks ----------

_LIST = re.compile(r"^(?P<indent> *)(?P<marker>[-*]|\d+\.) (?P<text>.*)$")
_IMAGE = re.compile(r"^(?P<indent> *)!\[(?P<caption>[^\]]*)\]\((?P<path>[^)]+)\)\s*$")
_CALLOUT = re.compile(r"^(?P<indent> *)> (?P<emoji>\S+) (?P<text>.*)$")


def md_to_blocks(markdown, base_dir="."):
    """A small, strict markdown subset -> Notion blocks.

    Supported, one per line: `#`/`##`/`###` headings, paragraphs, `- ` bullets,
    `1. ` numbered steps, `> <emoji> text` callouts, and `![caption](file.png)`
    images (a path relative to base_dir; the file is uploaded). A list item, image or
    callout indented further than the list item above it becomes that item's child.
    Each unindented line of plain text is its own paragraph; blank lines are ignored.
    An indented line that is none of these is an error, so nothing is lost silently.
    """
    blocks = []
    stack = []  # (indent, block) for open list items

    def add(block, indent):
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if stack:
            parent = stack[-1][1]
            parent[parent["type"]].setdefault("children", []).append(block)
        else:
            blocks.append(block)

    for raw in markdown.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            if level > 3:
                raise ValueError("Notion has only three heading levels: " + line)
            stack.clear()
            blocks.append(_block("heading_%d" % level, line[level:].strip()))
            continue
        m = _IMAGE.match(line)
        if m:
            path = os.path.join(base_dir, m.group("path"))
            add(image(path, m.group("caption")), indent)
            continue
        m = _CALLOUT.match(line)
        if m:
            add(_block("callout", m.group("text"), icon={"type": "emoji", "emoji": m.group("emoji")}), indent)
            continue
        m = _LIST.match(line)
        if m:
            kind = "bulleted_list_item" if m.group("marker") in "-*" else "numbered_list_item"
            block = _block(kind, m.group("text"))
            add(block, indent)
            stack.append((indent, block))
            continue
        if indent:
            raise ValueError("Indented line that is not a list item, image or callout: " + raw)
        stack.clear()
        blocks.append(_block("paragraph", line))
    return blocks


# ---------- pages ----------


def rewrite(page, blocks, batch=50):
    """Replace the whole body of a page. Notion allows 100 blocks per PATCH."""
    old = api("GET", "blocks/%s/children?page_size=100" % page)["results"]
    while old:
        for blk in old:
            api("DELETE", "blocks/" + blk["id"])
        old = api("GET", "blocks/%s/children?page_size=100" % page)["results"]
    for i in range(0, len(blocks), batch):
        api("PATCH", "blocks/%s/children" % page, {"children": blocks[i : i + batch]})
        time.sleep(0.4)
    return len(blocks)


def children(block_id):
    """Every child block, following Notion's pagination."""
    out, cursor = [], None
    while True:
        path = "blocks/%s/children?page_size=100" % block_id
        if cursor:
            path += "&start_cursor=" + cursor
        r = api("GET", path)
        out += r["results"]
        if not r["has_more"]:
            return out
        cursor = r["next_cursor"]


def dump(block_id, indent=""):
    """Print a page's blocks as indented text, one block per line."""
    for b in children(block_id):
        data = b[b["type"]]
        text = "".join(t["plain_text"] for t in data.get("rich_text", []))
        if b["type"] == "child_page":
            text = data["title"]
        elif b["type"] == "link_to_page":
            text = "-> " + data.get("page_id", data.get("database_id", ""))
        elif b["type"] == "image":
            text = "(image) " + "".join(t["plain_text"] for t in data.get("caption", []))
        elif b["type"] == "callout":
            text = "[%s] %s" % (data.get("icon", {}).get("emoji", ""), text)
        print("%s%s  %s: %s" % (indent, b["id"], b["type"], text))
        if b["has_children"] and b["type"] != "child_page":
            dump(b["id"], indent + "  ")


def _prop_text(v):
    t = v["type"]
    if t in ("title", "rich_text"):
        return "".join(x["plain_text"] for x in v[t])
    if t in ("select", "status"):
        return (v[t] or {}).get("name", "")
    if t == "multi_select":
        return ", ".join(x["name"] for x in v[t])
    if t == "formula":
        return str(v["formula"].get(v["formula"]["type"]))
    if t == "people":
        return ", ".join(x.get("name", x["id"]) for x in v[t])
    return "(%s)" % t


def props(page):
    """Print a page's properties, one per line."""
    p = api("GET", "pages/" + page)
    print("url: " + p["url"])
    for name, v in p["properties"].items():
        print("%s [%s] = %s" % (name, v["type"], _prop_text(v)))


def set_props(page, pairs):
    """Set Database properties from Name=Value strings, typed by the Database schema.
    A multi_select value is comma-separated. A select value that is not yet an option
    becomes a new option."""
    schema = api("GET", "databases/" + DATABASE)["properties"]
    out = {}
    for pair in pairs:
        name, value = pair.split("=", 1)
        t = schema[name]["type"]
        if t in ("title", "rich_text"):
            out[name] = {t: rich(value)}
        elif t == "select":
            out[name] = {"select": {"name": value}}
        elif t == "multi_select":
            out[name] = {"multi_select": [{"name": x.strip()} for x in value.split(",") if x.strip()]}
        elif t == "checkbox":
            out[name] = {"checkbox": value.lower() == "true"}
        else:
            raise ValueError("notion_docs.py does not set %s properties (%s)" % (t, name))
    api("PATCH", "pages/" + page, {"properties": out})


def create(title):
    """Make an empty page in the docs Database and return its id."""
    p = api(
        "POST",
        "pages",
        {"parent": {"database_id": DATABASE}, "properties": {"Name": {"title": rich(title)}}},
    )
    return p["id"]


def link(outline_page, target, after=None):
    """Add a link to target on an Outline page: at the end, or just after the block
    whose id is `after`. Returns the new block's id."""
    body = {"children": [{"object": "block", "type": "link_to_page", "link_to_page": {"type": "page_id", "page_id": target}}]}
    if after:
        body["after"] = after
    # The reply lists more than the new block, so find it by its target.
    results = api("PATCH", "blocks/%s/children" % outline_page, body)["results"]
    added = [
        b for b in results
        if b["type"] == "link_to_page" and b["link_to_page"].get("page_id", "").replace("-", "") == page_id(target)
    ]
    return added[0]["id"]


def search(text):
    """Print the pages and databases whose title matches text."""
    r = api("POST", "search", {"query": text, "page_size": 25})
    for x in r["results"]:
        if x["object"] == "database":
            title = "".join(t["plain_text"] for t in x["title"])
        else:
            title = "".join(
                _prop_text(v) for v in x["properties"].values() if v["type"] == "title"
            )
        print("%s %s parent=%s :: %s" % (x["object"], x["id"], x["parent"]["type"], title))


def main(argv):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    cmd, args = argv[0], argv[1:]
    if cmd == "dump":
        dump(page_id(args[0]))
    elif cmd == "props":
        props(page_id(args[0]))
    elif cmd == "search":
        search(" ".join(args))
    elif cmd == "create":
        print(create(" ".join(args)))
    elif cmd == "set":
        set_props(page_id(args[0]), args[1:])
    elif cmd == "write":
        with open(args[1], encoding="utf-8") as f:
            blocks = md_to_blocks(f.read(), os.path.dirname(os.path.abspath(args[1])))
        print("%d blocks written" % rewrite(page_id(args[0]), blocks))
    elif cmd == "link":
        print(link(page_id(args[0]), page_id(args[1]), args[2] if len(args) > 2 else None))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:] or ["help"])
