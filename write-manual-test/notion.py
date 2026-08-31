"""Minimal Notion REST helpers for writing a manual test case card.

Usage: copy this next to a script that builds a list of blocks, then

    from notion import api, h2, n, v, p, b, callout, image, rewrite
    rewrite(PAGE_ID, blocks)

The token comes from the BLOOM_TESTCASE_NOTION environment variable.
"""

import io, json, mimetypes, os, time, urllib.request, uuid

BASE = "https://api.notion.com/v1/"


def _headers(content_type="application/json"):
    h = {
        "Authorization": "Bearer " + os.environ["BLOOM_TESTCASE_NOTION"],
        "Notion-Version": "2022-06-28",
    }
    if content_type:
        h["Content-Type"] = content_type
    return h


def api(method, path, body=None):
    """One JSON call to the Notion API."""
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=_headers())
    return json.load(urllib.request.urlopen(r))


def rt(text, code=False, bold=False):
    """A rich-text run."""
    return [
        {
            "type": "text",
            "text": {"content": text},
            "annotations": {"code": code, "bold": bold},
        }
    ]


def h2(t):
    return {"object": "block", "type": "heading_2", "heading_2": {"rich_text": rt(t)}}


def h3(t):
    return {"object": "block", "type": "heading_3", "heading_3": {"rich_text": rt(t)}}


def p(t):
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": rt(t)}}


def b(t):
    return {
        "object": "block",
        "type": "bulleted_list_item",
        "bulleted_list_item": {"rich_text": rt(t)},
    }


def n(t):
    """A numbered step: something the tester does."""
    return {
        "object": "block",
        "type": "numbered_list_item",
        "numbered_list_item": {"rich_text": rt(t)},
    }


def v(t):
    """A verification: a checkbox that starts with the word Verify."""
    return {
        "object": "block",
        "type": "to_do",
        "to_do": {"rich_text": rt("Verify " + t), "checked": False},
    }


def callout(t, emoji="⚠️"):
    return {
        "object": "block",
        "type": "callout",
        "callout": {"rich_text": rt(t), "icon": {"type": "emoji", "emoji": emoji}},
    }


def link(text, url):
    return {
        "object": "block",
        "type": "paragraph",
        "paragraph": {
            "rich_text": [{"type": "text", "text": {"content": text, "link": {"url": url}}}]
        },
    }


def upload(path):
    """Upload one local file and return its file_upload id. Good for one block."""
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    fid = api("POST", "file_uploads", {"filename": name, "content_type": ctype})["id"]

    boundary = "----notion" + uuid.uuid4().hex
    body = io.BytesIO()
    body.write(("--" + boundary + "\r\n").encode())
    body.write(
        ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % name).encode()
    )
    body.write(("Content-Type: %s\r\n\r\n" % ctype).encode())
    body.write(open(path, "rb").read())
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


def image(path):
    """An image block holding a local screenshot."""
    return {
        "object": "block",
        "type": "image",
        "image": {"type": "file_upload", "file_upload": {"id": upload(path)}},
    }


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


def check_images(page):
    """Read the page back; return how many image blocks came back without a URL."""
    kids = api("GET", "blocks/%s/children?page_size=100" % page)["results"]
    return sum(
        1 for k in kids if k["type"] == "image" and not k["image"].get("file", {}).get("url")
    )
