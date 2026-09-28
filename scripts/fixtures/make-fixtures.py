"""Generate the binary fixtures scripts/test-files.cjs reads.

Committed alongside its output so the fixtures are reproducible rather than mystery bytes. Run with
any Python 3 — nothing outside the standard library is used:

    python scripts/fixtures/make-fixtures.py

The PDFs are written by hand with a real xref table (offsets computed, not guessed) so that a reader
bug shows up as a failure rather than being absorbed by a lenient parser. `empty.pdf` has a valid
page and no text at all — it stands in for a scanned document, which must be reported as unreadable
rather than silently arriving as an empty string.
"""
import os
import zipfile

OUT = os.path.dirname(os.path.abspath(__file__))


def pdf(path, text):
    """A one-page PDF. `text=None` gives a page with no text layer."""
    if text is None:
        content = b"BT ET"
    else:
        content = ("BT /F1 18 Tf 20 100 Td (%s) Tj ET" % text).encode()
    objects = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]"
        b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
        b"<</Length %d>>stream\n" % len(content) + content + b"\nendstream",
        b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj" % i + body + b"endobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    with open(path, "wb") as fh:
        fh.write(bytes(out))
    return len(out)


def docx(path, paragraphs):
    """There is no way to write a Word file without a zip, so build the three parts it needs."""
    body = "".join(
        "<w:p><w:r><w:t>%s</w:t></w:r></w:p>" % p for p in paragraphs
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>" + body + "</w:body></w:document>"
    )
    types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
        'officedocument.wordprocessingml.document.main+xml"/></Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
    return os.path.getsize(path)


if __name__ == "__main__":
    print("sample.pdf   ", pdf(os.path.join(OUT, "sample.pdf"), "Hello from a PDF 4729"), "bytes")
    print("empty.pdf    ", pdf(os.path.join(OUT, "empty.pdf"), None), "bytes")
    print("sample.docx  ", docx(os.path.join(OUT, "sample.docx"), ["Hello from a DOCX 4729", "Second paragraph."]), "bytes")
    # A quoted field containing a comma: the reason .csv goes through a real parser, not a split.
    csv = 'name,note,qty\nwidget,"has, a comma",3\ngizmo,plain,7\n'
    with open(os.path.join(OUT, "sample.csv"), "w", encoding="utf-8", newline="") as fh:
        fh.write(csv)
    print("sample.csv   ", len(csv.encode()), "bytes")
    with open(os.path.join(OUT, "notes.md"), "w", encoding="utf-8") as fh:
        fh.write("# Notes\n\nThe quick brown fox, 4729.\n")
    print("notes.md     ", os.path.getsize(os.path.join(OUT, "notes.md")), "bytes")
