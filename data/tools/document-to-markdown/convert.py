"""Convert a local PDF, DOCX or PPTX to the requested Markdown file."""
import io
import json
import os
import re
from contextlib import closing, ExitStack
from pathlib import Path
import sys
import tempfile
from urllib.parse import quote
import zipfile

MAX_SOURCE = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 256 * 1024 * 1024


def media_type(value):
    return value.partition(";")[0].strip().lower()


class DocumentImages:
    def __init__(self, destination, staging):
        self.directory = destination.with_name(destination.stem + "_images")
        self.staging = staging / "images"
        self.count = 0
        self.total_bytes = 0

    def save(self, data, extension):
        self.total_bytes += len(data)
        if self.total_bytes > MAX_IMAGE_BYTES or self.count >= 32_000:
            raise ValueError("Document images exceed 256 MiB or 32,000 files.")
        if self.count == 0:
            if os.path.lexists(self.directory):
                raise FileExistsError(f"Image directory already exists: {self.directory}")
            self.staging.mkdir()
        self.count += 1
        path = self.staging / f"image-{self.count}{extension}"
        path.write_bytes(data)
        return "./" + quote(self.directory.name, safe="") + "/" + path.name

    def png(self, image):
        with io.BytesIO() as data:
            image.save(data, format="PNG")
            return self.save(data.getvalue(), ".png")

    def office(self, data, mime):
        from PIL import Image
        if media_type(mime) == "image/svg+xml":
            return self.save(data, ".svg")
        with Image.open(io.BytesIO(data)) as image:
            extension = {"PNG": ".png", "JPEG": ".jpg", "GIF": ".gif",
                         "BMP": ".bmp", "WEBP": ".webp"}.get(image.format)
            if extension:
                return self.save(data, extension)
            with image.convert("RGBA") as pixels:
                return self.png(pixels)


def image_alt(text):
    return " ".join(text.split()).replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def word_markdown(content, images):
    import mammoth
    from anas_markitdown.converter_utils.docx.pre_process import pre_process_docx
    from anas_markitdown.converters._html_converter import HtmlConverter

    @mammoth.images.img_element
    def picture(image):
        with image.open() as stream:
            return {"src": images.office(stream.read(), image.content_type),
                    "alt": image_alt(image.alt_text or "")}

    document = pre_process_docx(io.BytesIO(content))
    # Keep the same precedence as MarkItDown: embedded styles, then underline.
    styles = (mammoth.read_embedded_style_map(document) or "") + "\nu => u"
    document.seek(0)
    html = mammoth.convert_to_html(document, convert_image=picture, style_map=styles,
                                   include_embedded_style_map=False).value
    return HtmlConverter().convert_string(html).markdown


def xml_markdown(node, inline=False):
    from lxml import etree

    markup = etree.tostring(node, encoding="unicode", with_tail=False)
    width = max((len(run) for run in re.findall(r"`+", markup)), default=0) + 1
    fence = "`" * max(1 if inline else 3, width)
    if inline:
        return f"{fence} {markup} {fence}"
    return f"\n{fence}xml\n{markup}\n{fence}\n"


def read_content_xml(target):
    import codecs
    from email.message import Message
    from lxml import etree

    header = Message()
    header["Content-Type"] = target.content_type
    encoding = header.get_content_charset()
    blob = target.blob
    if blob.startswith((codecs.BOM_UTF8, codecs.BOM_UTF16_BE, codecs.BOM_UTF16_LE, codecs.BOM_UTF32_BE)):
        encoding = None  # The XML byte order mark takes precedence over the MIME parameter.
    try:
        parser = etree.XMLParser(encoding=encoding, resolve_entities=False, no_network=True)
        node = etree.fromstring(blob, parser)
        return xml_markdown(node.getroottree())
    except (etree.XMLSyntaxError, LookupError):
        return None


def content_part_shape(part, relationship, mathml):
    """Give python-pptx a readable shape at the original position."""
    from pptx.oxml.ns import qn
    from pptx.oxml.shapes.autoshape import CT_Shape
    from pptx.oxml.shapes.picture import CT_Picture

    p14 = "{http://schemas.microsoft.com/office/powerpoint/2010/main}"
    props = part.find(p14 + "nvContentPartPr/" + p14 + "cNvPr")
    target = relationship.target_part if relationship is not None and not relationship.is_external else None
    if target is not None and media_type(target.content_type).startswith("image/"):
        shape = CT_Picture.new_pic(0, "", "", relationship.rId, 0, 0, 0, 0)
    else:
        shape = CT_Shape.new_textbox_sp(0, "", 0, 0, 0, 0)
        text = "[Unavailable PowerPoint content part]"
        if target is not None:
            markup = mathml[target] if target in mathml else read_content_xml(target)
            text = markup or f"[Unreadable PowerPoint XML: {target.partname}]"
        shape.txBody.p_lst[0].add_r(text)
    properties = shape._nvXxPr.cNvPr
    if props is not None:
        properties.attrib.update(props.attrib)
    if not properties.get("name") and target is not None:
        properties.set("name", Path(target.partname).name)
    transform = part.find(p14 + "xfrm")
    if transform is not None:
        transform.tag = qn("a:xfrm")
        shape.spPr.replace(shape.spPr.xfrm, transform)
    return shape


def prepare_slide_content(slide):
    from pptx.oxml.ns import qn

    root = slide.shapes._spTree
    mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
    a14 = "http://schemas.microsoft.com/office/drawing/2010/main"
    math = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
    changed = False
    ink_parts = set()
    native_shapes = {}
    unresolved_math = set()
    mathml = {}
    for part in root.iter(qn("p:contentPart")):
        rel = slide.part.rels.get(part.get(qn("r:id")))
        if rel is None or rel.is_external:
            continue
        target = rel.target_part
        mime = media_type(target.content_type)
        if mime == "application/inkml+xml":
            ink_parts.add(part)
        elif mime == "application/mathml+xml":
            if target not in mathml:
                mathml[target] = read_content_xml(target)
            if mathml[target] is None:
                unresolved_math.add(part)
            else:
                native_shapes[part] = "math"
        elif mime.startswith("image/"):
            native_shapes[part] = "image"

    shape_tags = {qn(tag) for tag in ("p:sp", "p:pic", "p:graphicFrame", "p:cxnSp", "p:contentPart")}

    def drawing_members(container):
        for child in container:
            if child.tag in shape_tags:
                yield child
            elif child.tag == qn("p:grpSp"):
                yield from drawing_members(child)

    def is_picture(shape):
        return shape.tag == qn("p:pic") or native_shapes.get(shape) == "image"

    def has_content(shape):
        return (shape in native_shapes or shape.tag in (qn("p:pic"), qn("p:graphicFrame"))
                or any(t.text for t in shape.iter(qn("a:t"), math + "t")))

    def branches_to_read(alternate):
        # A picture in an earlier choice can be a preview of ink in a later one.
        for branch in alternate:
            if (branch.tag in (mc + "Choice", mc + "Fallback")
                    and not ink_parts.isdisjoint(branch.iter(qn("p:contentPart")))):
                return (branch,)

        damaged = incomplete = None
        native_preview = other_preview = None
        for choice in alternate.iterchildren(mc + "Choice"):
            members = list(drawing_members(choice))
            if any(member in unresolved_math for member in members):
                if damaged is None:
                    damaged = choice
                if incomplete is None and any(has_content(member) for member in members):
                    incomplete = choice
                continue
            requires = choice.get("Requires", "").split()
            if members and all(is_picture(obj) for obj in members):
                if native_preview is None and any(obj in native_shapes for obj in members):
                    native_preview = choice
                elif other_preview is None:
                    other_preview = choice
                continue
            if (any(member in native_shapes for member in members)
                    or (requires and all(choice.nsmap.get(prefix) == a14 for prefix in requires)
                        and choice.find(".//{" + a14 + "}m//" + math + "oMath") is not None)):
                return (choice,)

        fallback = native_preview if native_preview is not None else alternate.find(mc + "Fallback")
        if other_preview is not None and (fallback is None or len(fallback) == 0):
            fallback = other_preview
        if damaged is not None:
            fallback_members = list(drawing_members(fallback)) if fallback is not None else []
            if not fallback_members:
                return (incomplete if incomplete is not None else damaged,)
            if all(is_picture(obj) for obj in fallback_members):
                # Enclosing groups can use this preview without selecting a second one.
                for obj in fallback_members:
                    native_shapes[obj] = "image"
                if incomplete is not None:
                    unresolved_math.difference_update(drawing_members(incomplete))
                    return incomplete, fallback
        return (fallback,) if fallback is not None else ()

    for alternate in reversed(list(root.iter(mc + "AlternateContent"))):
        branches = branches_to_read(alternate)
        if branches:
            for branch in branches:
                for child in list(branch):
                    alternate.addprevious(child)
            alternate.getparent().remove(alternate)
            changed = True

    for part in list(root.iter(qn("p:contentPart"))):
        if part in ink_parts:
            part.getparent().remove(part)
        else:
            rel = slide.part.rels.get(part.get(qn("r:id")))
            part.getparent().replace(part, content_part_shape(part, rel, mathml))
        changed = True
    return changed


def prepare_equations(root, keep_equation):
    from anas_markitdown.converter_utils.docx.math.latex_dict import CHR
    from anas_markitdown.converter_utils.docx.math.omml import OMML_NS as math, oMath2Latex
    from copy import deepcopy
    from lxml import etree
    from pptx.oxml.ns import qn

    class SlideMath(oMath2Latex):
        def call_method(self, element, stag=None):
            if stag == "r":
                # MarkItDown reads the ASCII text but ignores its mathematical alphabet.
                script = element.find(math + "rPr/" + math + "scr")
                style = element.find(math + "rPr/" + math + "sty")
                if ((script is not None and script.get(math + "val", "roman") != "roman")
                        or (style is not None and style.get(math + "val") in ("b", "bi"))):
                    raise ValueError("Unsupported mathematical alphabet or bold symbol")
            if stag in ("acc", "groupChr"):
                symbol = element.find(math + stag + "Pr/" + math + "chr")
                if symbol is not None and symbol.get(math + "val") not in CHR:
                    raise ValueError("Unsupported Office Math accent or group character")
            if stag == "f" and element.find(math + "fPr") is None:
                # MarkItDown expects a properties element even for a default fraction.
                element = deepcopy(element)
                element.insert(0, etree.Element(math + "fPr"))
            if stag == "nary" and element.find(math + "naryPr/" + math + "chr") is None:
                raise ValueError("Implicit n-ary operator")
            return super().call_method(element, stag)

        def process_children_dict(self, element, include=None):
            children = {}
            for tag, value, _ in self.process_children_list(element, include=include):
                if tag in children:
                    raise ValueError(f"Multiple Office Math arguments: {tag}")
                children[tag] = value
            return children

        def process_unknow(self, element, tag):
            value = super().process_unknow(element, tag)
            if value is None:
                raise ValueError(f"Unsupported Office Math element: {tag}")
            return value

    changed = False
    for formula in root.findall(".//" + qn("a:p") + "/{http://schemas.microsoft.com/office/drawing/2010/main}m"):
        expressions = list(formula.iter(math + "oMath"))
        if not expressions:
            continue
        in_cell = next(formula.iterancestors(qn("a:tc")), None) is not None
        run = etree.Element(qn("a:r"))
        fragments = []
        for expression in expressions:
            display = expression.getparent().tag == math + "oMathPara" and not in_cell
            try:
                latex = str(SlideMath(expression)).strip()
                if not latex:
                    raise ValueError("Empty LaTeX")
                fragment = f"$$\n{latex}\n$$" if display else f"${latex}$"
            except (KeyError, ValueError, TypeError, AttributeError, NotImplementedError):
                fragment = xml_markdown(expression, inline=not display)
            if in_cell:
                fragment = fragment.replace("\n", " ").replace("|", r"\|")
            fragments.append(fragment)
        # Table conversion escapes normal text. Restore the finished equations after that pass.
        text = keep_equation(" ".join(fragments)) if in_cell else "\n".join(fragments)
        etree.SubElement(run, qn("a:t")).text = text
        formula.getparent().replace(formula, run)
        changed = True
    return changed


def slides_markdown(content, images):
    from anas_markitdown._stream_info import StreamInfo
    from anas_markitdown.converters._pptx_converter import PptxConverter
    from PIL import Image
    from pptx import Presentation
    from uuid import uuid4

    class Slides(PptxConverter):
        def _convert_table_to_markdown(self, table, **kwargs):
            # GFM consumes a following footnote/text box as a table row without a blank line.
            return "\n\n" + super()._convert_table_to_markdown(table, **kwargs).strip() + "\n\n"

        def _convert_picture_to_markdown(self, shape, **kwargs):
            alt = image_alt(shape._element._nvXxPr.cNvPr.get("descr") or shape.name)
            rid = shape._element.blip_rId
            part = shape.part.related_part(rid) if rid else self._find_svg_blip_part(shape)
            if part is None:
                return f"\n{alt}\n"
            extension = Path(part.partname).suffix.lower()
            if extension in {".emf", ".wmf"} and not hasattr(Image.core, "drawwmf"):
                link = images.save(part.blob, extension)
                return f"\n[{alt} ({extension[1:].upper()})]({link})\n"
            link = images.office(part.blob, part.content_type)
            return f"\n![{alt}]({link})\n"

    prefix = "AnasMath" + uuid4().hex + "X"
    equations = []

    def keep_equation(markdown):
        equations.append(markdown)
        return f"{prefix}{len(equations) - 1}Z"

    stream = io.BytesIO(content)
    presentation = Presentation(stream)
    changed = False
    for slide in presentation.slides:
        pages = (slide, slide.notes_slide) if slide.has_notes_slide else (slide,)
        for page in pages:
            if prepare_slide_content(page):
                changed = True
            if prepare_equations(page.shapes._spTree, keep_equation):
                changed = True
    if changed:
        stream = io.BytesIO()
        presentation.save(stream)
    stream.seek(0)
    markdown = Slides().convert(stream, StreamInfo(extension=".pptx")).markdown
    if equations:
        markdown = re.sub(prefix + r"(\d+)Z", lambda match: equations[int(match[1])], markdown)
    return markdown


def pdf_picture(pdf, page, obj, images):
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_raw

    original = obj.get_matrix()
    left, bottom, right, top = original.on_rect(0, 0, 1, 1)
    width, height = right - left, top - bottom
    if width <= 0 or height <= 0:
        return None
    # Render the object's orientation and alpha mask within the Markdown preview limits.
    meta = obj.get_metadata()
    scale = min(max(meta.width, meta.height) / max(width, height),
                16_384 / max(width, height), (25_000_000 / (width * height)) ** 0.5)
    obj.set_matrix(original.scale(scale, scale))
    try:
        handle = pdfium_raw.FPDFImageObj_GetRenderedBitmap(pdf, page, obj)
    finally:
        obj.set_matrix(original)
    if not handle:
        raise ValueError("Cannot render an embedded PDF image.")
    bitmap = pdfium.PdfBitmap.from_raw(handle)
    with bitmap.to_pil() as image:
        return images.png(image)


def pdf_markdown(content, images):
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_raw
    from anas_markitdown._stream_info import StreamInfo
    from anas_markitdown.converters._pdf_converter import PdfConverter

    text = PdfConverter().convert(io.BytesIO(content), StreamInfo(extension=".pdf")).markdown
    parts = [text.strip()] if text.strip() else []
    with closing(pdfium.PdfDocument(content)) as pdf:
        for index in range(len(pdf)):
            with closing(pdf[index]) as page:
                for obj in page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE], max_depth=15):
                    link = pdf_picture(pdf, page, obj, images)
                    if link:
                        parts.append(f"![Page {index + 1}]({link})")
    return "\n\n".join(parts)


def convert(content, extension, images):
    if extension != ".pdf":
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            members = archive.infolist()
            if len(members) > 32_000 or sum(member.file_size for member in members) > 256 * 1024 * 1024:
                raise ValueError("Office archive exceeds 32,000 entries or 256 MiB of expanded content.")
    sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
    converter = {".pdf": pdf_markdown, ".docx": word_markdown, ".pptx": slides_markdown}[extension]
    markdown = converter(content, images)
    if not markdown or markdown.isspace():
        raise ValueError("No extractable text or images.")
    if "\x00" in markdown:
        raise ValueError("Markdown contains a null character and cannot be read as text.")
    return markdown.encode("utf-8")


def publish_new(staged, destination):
    if sys.platform == "darwin":
        # Atomic no-replace rename, including on volumes without hard links.
        import ctypes
        rename = ctypes.CDLL(None, use_errno=True).renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        if rename(os.fsencode(staged), os.fsencode(destination), 0x4):  # RENAME_EXCL
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error), destination)
    elif os.name == "nt":
        staged.rename(destination)
    elif staged.is_dir():
        destination.mkdir()
        try:
            staged.rename(destination)
        except OSError:
            destination.rmdir()
            raise
    else:
        os.link(staged, destination)


def main():
    args = json.loads(sys.argv[1])
    source = Path(args["input_path"])
    destination = Path(args["output_path"])
    if not source.is_absolute() or not source.is_file():
        raise ValueError("Supply an absolute path to an existing local file.")
    extension = source.suffix.lower()
    if extension not in {".pdf", ".docx", ".pptx"}:
        raise ValueError("Supported document formats: PDF, DOCX, PPTX.")
    if not destination.is_absolute() or destination.is_dir():
        raise ValueError("output_path must be an absolute filename.")
    if destination.resolve().is_relative_to(Path(sys.base_prefix).resolve()):
        raise ValueError("Choose an output_path outside the bundled Python runtime.")
    if os.path.lexists(destination):
        raise FileExistsError(f"Output already exists: {destination}")
    if source.stat().st_size > MAX_SOURCE:
        raise ValueError("Document exceeds the 64 MiB input limit.")
    with source.open("rb") as stream:
        content = stream.read(MAX_SOURCE + 1)
    if len(content) > MAX_SOURCE:
        raise ValueError("Document exceeds the 64 MiB input limit.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".anas-md-") as work, ExitStack() as rollback:
        staging = Path(work)
        images = DocumentImages(destination, staging)
        markdown = convert(content, extension, images)
        staged_md = staging / "document.md"
        staged_md.write_bytes(markdown)
        if images.count:
            files = list(images.staging.iterdir())
            publish_new(images.staging, images.directory)
            rollback.callback(images.directory.rmdir)
            for file in files:
                rollback.callback((images.directory / file.name).unlink, missing_ok=True)
        publish_new(staged_md, destination)
        rollback.pop_all()
    print("[Converted document · Markdown]")
    print("Source:", json.dumps(str(source), ensure_ascii=False))
    print("Complete Markdown:", json.dumps(str(destination), ensure_ascii=False))
    print("Lines:", markdown.count(b"\n") + int(not markdown.endswith(b"\n")))
    print("Bytes:", len(markdown))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Document conversion failed: {error}", file=sys.stderr)
        sys.exit(1)
