"""Run with the prepared (or packaged) Python. All files stay in a temporary profile."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import unquote
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "data/tools/document-to-markdown/convert.py"


def write_docx(path, text, picture=None):
    drawing = ""
    if picture is not None:
        drawing = """<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
          <wp:docPr id="1" name="Picture" descr="Sales trend"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>
          <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="img1"/>
          </pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml", f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{text}</w:t></w:r>{drawing}</w:p></w:body></w:document>')
        if picture is not None:
            archive.writestr("word/media/image1.png", picture)
            archive.writestr("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="img1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>')


def write_pdf(path, text):
    stream = f"BT /F1 12 Tf 50 700 Td ({text}) Tj ET".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"]
    data = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(data)
    data.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets:
        data.extend(f"{offset:010} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    path.write_bytes(data)


class Documents(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_tool(self, path, output_path, success=True):
        args = {"input_path": str(path)}
        if output_path is not None:
            args["output_path"] = str(output_path)
        result = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(SCRIPT), json.dumps(args)],
                                env={**os.environ, "ANAS_CACHE_DIR": str(self.root / "cache")},
                                capture_output=True, encoding="utf-8", timeout=45)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            return result.stderr
        self.assertEqual(result.returncode, 0, result.stderr)
        data = output_path.read_bytes()
        self.assertEqual(result.stdout.splitlines(), [
            "[Converted document · Markdown]",
            "Source: " + json.dumps(str(path), ensure_ascii=False),
            "Complete Markdown: " + json.dumps(str(output_path), ensure_ascii=False),
            f"Lines: {len(data.decode('utf-8').splitlines())}",
            f"Bytes: {len(data)}",
        ])
        return output_path

    def test_word_writes_only_the_requested_markdown(self):
        source = self.root / "中文 文件.docx"
        output = self.root / "导出 文档" / "报告.md"
        title = "标题" * 180_000
        write_docx(source, title)
        self.run_tool(source, output)
        self.assertIn("**" + title + "**", output.read_text(encoding="utf-8"))
        self.assertCountEqual(self.root.rglob("*"), [source, output.parent, output])

    def test_requires_a_new_absolute_output_path(self):
        source = self.root / "报告.docx"
        write_docx(source, "季度营收")
        original = source.read_bytes()
        self.assertIn("output_path", self.run_tool(source, None, success=False))
        self.assertIn("absolute filename", self.run_tool(source, Path("relative.md"), success=False))
        self.assertIn("already exists", self.run_tool(source, source, success=False))
        self.assertEqual(source.read_bytes(), original)
        output = self.root / "notes.md"
        output.write_text("personal notes", encoding="utf-8")
        self.assertIn("already exists", self.run_tool(source, output, success=False))
        self.assertEqual(output.read_text(encoding="utf-8"), "personal notes")

    def test_embedded_pictures_link_to_viewable_files_next_to_markdown(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from PIL import Image
        from pptx import Presentation
        from pptx.util import Inches
        picture = Image.new("RGB", (80, 48), "red")
        data = io.BytesIO()
        picture.save(data, format="PNG")
        word = self.root / "source.docx"
        write_docx(word, "Before picture", data.getvalue())
        slides = self.root / "source.pptx"
        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        data.seek(0)
        shape = slide.shapes.add_picture(data, Inches(1), Inches(1))
        shape._element.nvPicPr.cNvPr.set("descr", "Sales trend")
        deck.save(slides)
        scan = self.root / "source.pdf"
        picture.save(scan, format="PDF", save_all=True, append_images=[Image.new("RGB", (80, 48), "blue")])
        for source, colors in [(word, ["red"]), (slides, ["red"]), (scan, ["red", "blue"])]:
            with self.subTest(source=source):
                output = self.root / source.suffix[1:] / "报告 (A) #1%.md"
                md = self.run_tool(source, output).read_text(encoding="utf-8")
                links = re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", md)
                self.assertEqual(len(links), len(colors))
                for page, ((alt, link), color) in enumerate(zip(links, colors), 1):
                    self.assertEqual(alt, f"Page {page}" if source == scan else "Sales trend")
                    relative = Path(unquote(link))
                    self.assertEqual(relative.parent, Path(output.stem + "_images"))
                    with Image.open(output.parent / relative) as saved:
                        saved.load()
                        r, g, b = saved.convert("RGB").getpixel((10, 10))
                        self.assertGreater(r if color == "red" else b, 200)
                        self.assertLess(g, 32)
        occupied = self.root / "existing_images"
        occupied.mkdir()
        existing = occupied / "image-1.png"
        existing.write_bytes(b"keep")
        self.run_tool(word, self.root / "existing.md", success=False)
        self.assertEqual(existing.read_bytes(), b"keep")
        self.assertFalse((self.root / "existing.md").exists())

    def test_pdf_and_presentation(self):
        pdf = self.root / "sample.pdf"
        write_pdf(pdf, "Quarterly report")
        self.assertIn("Quarterly report", self.run_tool(pdf, pdf.with_suffix(".md")).read_text(encoding="utf-8"))
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from pptx import Presentation
        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[1])
        slide.shapes.title.text = "季度计划"
        slide.placeholders[1].text = "第一项"
        slide.notes_slide.notes_text_frame.text = "Speaker notes"
        path = self.root / "演示.PPTX"
        deck.save(path)
        result = self.run_tool(path, path.with_suffix(".md")).read_text(encoding="utf-8")
        for item in ("季度计划", "第一项", "Speaker notes"):
            self.assertIn(item, result)

    def test_powerpoint_equations_alternate_images_and_table_boundaries(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from lxml import etree
        from PIL import Image
        from pptx import Presentation
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        from pptx.opc.package import Part
        from pptx.opc.packuri import PackURI
        from pptx.oxml.ns import qn
        from pptx.util import Inches

        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        table = slide.shapes.add_table(2, 1, 0, 0, Inches(3), Inches(1)).table
        table.cell(0, 0).text = "Header"
        table.cell(1, 0).text = "Cell"

        def textbox(top, text):
            shape = slide.shapes.add_textbox(0, Inches(top), Inches(3), Inches(1))
            shape.text = text
            return shape

        def alternatives(native, prefix, uri, fallback):
            mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
            node = etree.Element(mc + "AlternateContent", nsmap={prefix: uri})
            native.addprevious(node)
            etree.SubElement(node, mc + "Choice", Requires=prefix).append(native)
            etree.SubElement(node, mc + "Fallback").append(fallback)

        textbox(1, "[1] Footnote")
        equations = textbox(2, "before")
        para = equations.text_frame.paragraphs[0]
        a14 = "http://schemas.microsoft.com/office/drawing/2010/main"
        math = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"

        def add_equation(p, display, value):
            wrapper = etree.SubElement(p._p, "{" + a14 + "}m")
            parent = etree.SubElement(wrapper, math + "oMathPara") if display else wrapper
            expression = etree.SubElement(parent, math + "oMath")
            etree.SubElement(etree.SubElement(expression, math + "r"), math + "t").text = value

        add_equation(para, False, "x")
        para.add_run().text = "after"
        add_equation(equations.text_frame.add_paragraph(), True, "y")
        alternatives(equations._element, "draw", a14, textbox(2, "Equation preview")._element)

        picture = io.BytesIO()
        Image.new("RGB", (20, 20), "gold").save(picture, format="PNG")
        p14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
        ink = Part(PackURI("/ppt/ink/ink1.xml"), "application/InkML+xml", deck.part.package,
                   b'<ink xmlns="http://www.w3.org/2003/InkML"><trace>1 2, 3 4</trace></ink>')
        ink_id = slide.part.relate_to(ink, RT.CUSTOM_XML)
        group = slide.shapes.add_group_shape()
        preview = group.shapes.add_picture(picture, 0, Inches(3))
        preview._element.nvPicPr.cNvPr.set("descr", "Stroke preview")
        native = etree.SubElement(group._element, qn("p:contentPart"), {qn("r:id"): ink_id})
        alternatives(native, "ink", p14, preview._element)
        etree.SubElement(slide.shapes._spTree, qn("p:contentPart"), {qn("r:id"): ink_id})

        # An unrelated object can use the same namespace, image bytes and an ink-like label.
        pic = slide.shapes.add_picture(picture, 0, Inches(3))
        pic._element.nvPicPr.cNvPr.set("descr", "Handwriting")
        alternatives(textbox(3, "Alternate diagram")._element, "p14", p14, pic._element)
        source = self.root / "alternatives.pptx"
        deck.save(source)
        output = self.root / "result.md"
        md = self.run_tool(source, output).read_text(encoding="utf-8")
        self.assertIn("| Cell |\n\n[1] Footnote", md)
        self.assertEqual(md.count("before$x$after"), 1)
        self.assertEqual(md.count("$$\ny\n$$"), 1)
        self.assertNotIn("Equation preview", md)
        self.assertNotIn("Stroke preview", md)
        self.assertNotIn("Alternate diagram", md)
        self.assertEqual(md.count("![Handwriting](./result_images/image-1.png)"), 1)
        self.assertEqual(len(list((self.root / "result_images").iterdir())), 1)
        self.assertEqual((self.root / "result_images/image-1.png").read_bytes(), picture.getvalue())

    def test_mixed_ink_group_keeps_the_other_picture_and_text(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from copy import deepcopy
        from lxml import etree
        from PIL import Image
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        from pptx.opc.package import Part
        from pptx.opc.packuri import PackURI
        from pptx.oxml.ns import qn
        from pptx.util import Inches

        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>'
        p14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
        mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"

        def alternate(native, fallback):
            node = etree.Element(mc + "AlternateContent", nsmap={"p14": p14})
            native.addprevious(node)
            etree.SubElement(node, mc + "Choice", Requires="p14").append(native)
            etree.SubElement(node, mc + "Fallback").append(fallback)

        for variant in ("matching", "swapped", "filled-preview", "nested-filled-preview", "unidentified"):
            with self.subTest(variant=variant):
                deck = Presentation()
                slide = deck.slides.add_slide(deck.slide_layouts[6])
                slide.shapes.add_textbox(0, 0, Inches(2), Inches(1)).text = "Slide text"
                native = slide.shapes.add_group_shape()
                fallback = slide.shapes.add_group_shape()
                native.shapes.add_textbox(0, 0, Inches(2), Inches(1)).text = "Q3 revenue 42"
                table = slide.shapes.add_table(2, 2, 0, Inches(2), Inches(2), Inches(1))
                table.table.cell(0, 0).text = "Quarter"
                table.table.cell(0, 1).text = "Revenue"
                table.table.cell(1, 0).text = "Q3"
                table.table.cell(1, 1).text = "42"
                native._element.append(table._element)

                preview_ids = {}
                for name, color in (("Diagram", "red"), ("Ink", "blue")):
                    data = io.BytesIO()
                    Image.new("RGB", (8, 8), color).save(data, format="PNG")
                    pic = fallback.shapes.add_picture(data, 0, Inches(1))
                    pic._element.nvPicPr.cNvPr.set("descr", name)
                    preview_ids[name] = pic.shape_id
                    if name == "Diagram" and variant in ("filled-preview", "nested-filled-preview"):
                        rect = fallback.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(1), Inches(1))
                        fill = etree.SubElement(rect._element.spPr, qn("a:blipFill"))
                        etree.SubElement(fill, qn("a:blip"), {qn("r:embed"): pic._element.blip_rId})
                        etree.SubElement(etree.SubElement(fill, qn("a:stretch")), qn("a:fillRect"))
                        fallback._element.remove(pic._element)
                        preview_ids[name] = rect.shape_id
                if variant == "swapped":
                    preview_ids["Ink"], preview_ids["Diagram"] = preview_ids["Diagram"], preview_ids["Ink"]

                for name, filename, mime, blob in (
                    ("Ink", "ink.xml", "application/InkML+xml; charset=UTF-8", b'<ink xmlns="http://www.w3.org/2003/InkML"/>'),
                    ("Diagram", "diagram.svg", "image/SVG+xml; charset=utf-8", svg),
                ):
                    media = Part(PackURI("/ppt/customXml/" + filename), mime, deck.part.package, blob)
                    rid = slide.part.relate_to(media, RT.CUSTOM_XML)
                    part = etree.SubElement(native._element, qn("p:contentPart"), {qn("r:id"): rid})
                    if variant != "unidentified" and (variant != "filled-preview" or name == "Diagram"):
                        nv = etree.SubElement(part, "{" + p14 + "}nvContentPartPr")
                        etree.SubElement(nv, "{" + p14 + "}cNvPr", id=str(preview_ids[name]), name=name)
                    if variant == "nested-filled-preview" and name == "Diagram":
                        alternate(part, deepcopy(rect._element))

                alternate(native._element, fallback._element)
                source = self.root / f"mixed-{variant}.pptx"
                deck.save(source)
                output = source.with_suffix(".md")
                md = self.run_tool(source, output).read_text(encoding="utf-8")
                self.assertEqual(md.count("Slide text"), 1)
                self.assertEqual(md.count("Q3 revenue 42"), 1)
                self.assertIn("| Quarter | Revenue |", md)
                self.assertIn("| Q3 | 42 |", md)
                links = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", md)
                self.assertEqual(len(links), 1)
                image = output.parent / unquote(links[0])
                self.assertEqual(image.read_bytes(), svg)
                self.assertEqual(list(image.parent.iterdir()), [image])

    def test_powerpoint_ink_choices_and_mathml_content(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from lxml import etree
        from pptx import Presentation
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        from pptx.opc.package import Part
        from pptx.opc.packuri import PackURI
        from pptx.oxml.ns import qn
        from pptx.util import Inches

        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        root = slide.shapes._spTree
        mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
        p14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
        assets = {
            "ink.xml": ("application/inkml+xml; charset=utf-8", b'<ink xmlns="http://www.w3.org/2003/InkML"/>'),
            "preview.svg": ("image/svg+xml; charset=UTF-8", b'<svg xmlns="http://www.w3.org/2000/svg"/>'),
            "fraction.xml": ("application/mathml+xml; charset=iso-8859-1",
                             '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>café</mi>'
                             '<mfrac><mn>1</mn><mn>2</mn></mfrac></math>'.encode("latin-1")),
        }
        rids = {}
        for name, (mime, markup) in assets.items():
            part = Part(PackURI("/ppt/customXml/" + name), mime, deck.part.package, markup)
            rids[name] = slide.part.relate_to(part, RT.CUSTOM_XML)

        def insert_part(parent, name):
            return etree.SubElement(parent, qn("p:contentPart"), {qn("r:id"): rids[name]})

        for ink_branch in ("Choice", "Fallback"):
            alternative = etree.SubElement(root, mc + "AlternateContent", nsmap={"p14": p14})
            insert_part(etree.SubElement(alternative, mc + "Choice", Requires="p14"), "preview.svg")
            attrs = {"Requires": "p14"} if ink_branch == "Choice" else {}
            insert_part(etree.SubElement(alternative, mc + ink_branch, **attrs), "ink.xml")

        group = slide.shapes.add_group_shape()
        group.shapes.add_textbox(0, 0, Inches(3), Inches(1)).text = "Quarterly results"
        insert_part(group._element, "ink.xml")
        insert_part(group._element, "fraction.xml")
        alt = etree.Element(mc + "AlternateContent", nsmap={"p14": p14})
        group._element.addprevious(alt)
        etree.SubElement(alt, mc + "Choice", Requires="p14").append(group._element)
        insert_part(etree.SubElement(alt, mc + "Fallback"), "preview.svg")

        math_group = slide.shapes.add_group_shape()
        insert_part(math_group._element, "fraction.xml")
        grouped_alt = etree.Element(mc + "AlternateContent", nsmap={"p14": p14})
        math_group._element.addprevious(grouped_alt)
        etree.SubElement(grouped_alt, mc + "Choice", Requires="p14").append(math_group._element)
        insert_part(etree.SubElement(grouped_alt, mc + "Fallback"), "preview.svg")

        source = self.root / "ink-and-formula.pptx"
        deck.save(source)
        output = source.with_suffix(".md")
        md = self.run_tool(source, output).read_text(encoding="utf-8")
        self.assertEqual(md.count("Quarterly results"), 1)
        self.assertEqual(md.count("<mi>café</mi><mfrac><mn>1</mn><mn>2</mn></mfrac>"), 2)
        self.assertNotIn("![", md)
        self.assertFalse((self.root / "ink-and-formula_images").exists())

    def test_powerpoint_fraction_prescripts_table_and_notes(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from lxml import etree
        from pptx import Presentation
        from pptx.util import Inches

        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])

        def equation(paragraph, xml):
            wrapper = etree.fromstring(('<a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" '
                                        'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
                                        '<m:oMath>' + xml + '</m:oMath></a14:m>').encode())
            paragraph._p.append(wrapper)

        def run(text):
            return f"<m:r><m:t>{text}</m:t></m:r>"

        body = slide.shapes.add_textbox(0, 0, Inches(3), Inches(2)).text_frame
        fraction = "<m:f><m:num>" + run("1") + "</m:num><m:den>" + run("2") + "</m:den></m:f>"
        equation(body.paragraphs[0], fraction)
        prescript = "<m:sPre><m:sub>" + run("6") + "</m:sub><m:sup>" + run("14") + "</m:sup><m:e>" + run("C") + "</m:e></m:sPre>"
        equation(body.add_paragraph(), run("1+") + prescript)
        delimiter = "<m:d><m:dPr/><m:e>" + run("first") + "</m:e><m:e>" + run("second") + "</m:e></m:d>"
        equation(body.add_paragraph(), fraction + delimiter)
        integral = "<m:nary><m:sub>" + run("0") + "</m:sub><m:sup>" + run("1") + "</m:sup><m:e>" + run("x") + "</m:e></m:nary>"
        equation(body.add_paragraph(), integral)
        alphabet = '<m:r><m:rPr><m:scr m:val="double-struck"/><m:sty m:val="p"/></m:rPr><m:t>R</m:t></m:r>'
        equation(body.add_paragraph(), run("x∈") + alphabet)
        equation(body.add_paragraph(), run("x∈R"))
        accent = '<m:acc><m:accPr><m:chr m:val="→"/></m:accPr><m:e>' + run("v") + "</m:e></m:acc>"
        equation(body.add_paragraph(), accent)
        cell = slide.shapes.add_table(2, 1, 0, Inches(3), Inches(3), Inches(2)).table.cell(1, 0)
        equation(cell.text_frame.paragraphs[0], "<m:sSub><m:e>" + run("x") + "</m:e><m:sub>" + run("i") + "</m:sub></m:sSub>")
        notes = slide.notes_slide.notes_text_frame
        notes.text = "Before "
        equation(notes.paragraphs[0], run("x+y"))
        notes.paragraphs[0].add_run().text = " After"
        source = self.root / "formulas.pptx"
        deck.save(source)
        md = self.run_tool(source, source.with_suffix(".md")).read_text(encoding="utf-8")
        self.assertIn(r"$\frac{1}{2}$", md)
        self.assertIn(prescript, md)
        self.assertIn(fraction + delimiter, md)
        self.assertIn(integral, md)
        self.assertIn(alphabet, md)
        self.assertEqual(md.count(r"$x\in R$"), 1)
        self.assertIn(accent, md)
        self.assertNotIn("$1+$", md)
        self.assertIn("| $x_{i}$ |", md)
        self.assertIn("Before $x+y$ After", md)

    def test_powerpoint_keeps_usable_previews_for_unreadable_choices(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from lxml import etree
        from PIL import Image
        from pptx import Presentation
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        from pptx.opc.package import Part
        from pptx.opc.packuri import PackURI
        from pptx.oxml.ns import qn

        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
        ns = {"p14": "http://schemas.microsoft.com/office/powerpoint/2010/main", "ext": "urn:sample:new-drawing"}
        previews = {}
        for name, wrapper, preview in (("bad", False, True), ("new", True, True),
                                       ("alone", False, False), ("empty", False, False)):
            alt = etree.SubElement(slide.shapes._spTree, mc + "AlternateContent", nsmap=ns)
            choice = etree.SubElement(alt, mc + "Choice", Requires="ext" if wrapper else "p14")
            if wrapper:
                choice = etree.SubElement(choice, "{" + ns["ext"] + "}drawing")
            blob = b'<svg xmlns="http://www.w3.org/2000/svg"/>' if wrapper else b"<math><mfrac>"
            mime = "image/svg+xml" if wrapper else "application/mathml+xml"
            part = Part(PackURI("/ppt/customXml/" + name + ".xml"), mime, deck.part.package, blob)
            rid = slide.part.relate_to(part, RT.CUSTOM_XML)
            etree.SubElement(choice, qn("p:contentPart"), {qn("r:id"): rid})
            if preview:
                data = io.BytesIO()
                Image.new("RGB", (3, 3), "red" if wrapper else "green").save(data, "PNG")
                previews[name] = data.getvalue()
                pic = slide.shapes.add_picture(data, 0, 0)
                pic._element.nvPicPr.cNvPr.set("descr", name)
                etree.SubElement(alt, mc + "Fallback").append(pic._element)
            elif name == "empty":
                etree.SubElement(alt, mc + "Fallback")
        source = self.root / "previews.pptx"
        deck.save(source)
        md = self.run_tool(source, source.with_suffix(".md")).read_text(encoding="utf-8")
        links = re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", md)
        self.assertCountEqual([name for name, _ in links], previews)
        for name, link in links:
            self.assertEqual((self.root / unquote(link)).read_bytes(), previews[name])
        self.assertEqual(md.count("[Unreadable PowerPoint XML:"), 2)
        for name in ("alone", "empty"):
            self.assertIn(f"[Unreadable PowerPoint XML: /ppt/customXml/{name}.xml]", md)

    def test_powerpoint_group_with_damaged_formula_keeps_content_and_preview(self):
        sys.path.insert(0, str(Path(sys.base_prefix) / "anas-documents"))
        from copy import deepcopy
        from lxml import etree
        from PIL import Image
        from pptx import Presentation
        from pptx.opc.constants import RELATIONSHIP_TYPE as RT
        from pptx.opc.package import Part
        from pptx.opc.packuri import PackURI
        from pptx.oxml.ns import qn
        from pptx.util import Inches

        deck = Presentation()
        mc = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
        p14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
        broken = Part(PackURI("/ppt/customXml/broken.xml"), "application/mathml+xml", deck.part.package, b"<math>")
        valid = Part(PackURI("/ppt/customXml/good.xml"), "application/mathml+xml", deck.part.package,
                     b'<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>y</mi></math>')
        picture = io.BytesIO()
        Image.new("RGB", (8, 8), "blue").save(picture, "PNG")

        def wrap(slide, native, label):
            alt = etree.Element(mc + "AlternateContent", nsmap={"p14": p14})
            native.addprevious(alt)
            etree.SubElement(alt, mc + "Choice", Requires="p14").append(native)
            preview = slide.shapes.add_picture(picture, 0, 0)._element
            preview.nvPicPr.cNvPr.set("descr", label)
            etree.SubElement(alt, mc + "Fallback").append(preview)
            return alt

        for variant in ("group", "nested", "first-preview", "last-preview", "complete"):
            slide = deck.slides.add_slide(deck.slide_layouts[6])
            group = slide.shapes.add_group_shape()
            group.shapes.add_textbox(0, 0, Inches(3), Inches(1)).text = "Editable revenue " + variant
            table = slide.shapes.add_table(2, 2, 0, Inches(1), Inches(3), Inches(1))
            for row, values in enumerate((("Account", "Amount"), ("Sales", "42"))):
                for col, value in enumerate(values):
                    table.table.cell(row, col).text = value
            group._element.append(table._element)
            etree.SubElement(group._element, qn("p:contentPart"), {qn("r:id"): slide.part.relate_to(broken, RT.CUSTOM_XML)})
            alt = wrap(slide, group._element, "Group preview")
            if variant == "nested":
                outer = slide.shapes.add_group_shape()
                outer.shapes.add_textbox(0, 0, Inches(3), Inches(1)).text = "Outer caption"
                outer._element.append(alt)
                wrap(slide, outer._element, "Outer preview")
            elif variant in ("first-preview", "last-preview"):
                fallback = alt.find(mc + "Fallback")
                preview_choice = etree.Element(mc + "Choice", Requires="p14")
                preview_choice.append(fallback[0])
                alt.insert(0 if variant == "first-preview" else 1, preview_choice)
            elif variant == "complete":
                choice = etree.Element(mc + "Choice", Requires="p14")
                alt.find(mc + "Fallback").addprevious(choice)
                complete = deepcopy(group._element)
                complete.find(qn("p:contentPart")).set(qn("r:id"), slide.part.relate_to(valid, RT.CUSTOM_XML))
                choice.append(complete)

        source = self.root / "mixed-formulas.pptx"
        deck.save(source)
        md = self.run_tool(source, source.with_suffix(".md")).read_text(encoding="utf-8")
        pages = re.split(r"<!-- Slide number: \d+ -->", md)[1:]
        self.assertEqual(len(pages), 5)
        for variant, page in zip(("group", "nested", "first-preview", "last-preview"), pages):
            self.assertEqual(page.count("Editable revenue " + variant), 1)
            self.assertEqual(page.count("| Sales | 42 |"), 1)
            self.assertEqual(page.count("[Unreadable PowerPoint XML:"), 1)
            links = re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", page)
            self.assertEqual([alt for alt, _ in links], ["Group preview"])
            self.assertEqual((self.root / unquote(links[0][1])).read_bytes(), picture.getvalue())
        self.assertIn("Outer caption", pages[1])
        self.assertEqual(pages[-1].count("Editable revenue complete"), 1)
        self.assertEqual(pages[-1].count("| Sales | 42 |"), 1)
        self.assertIn("<mi>y</mi>", pages[-1])
        self.assertNotIn("![", pages[-1])
        self.assertNotIn("[Unreadable", pages[-1])

    def test_empty_pdf_corrupt_and_unsupported_inputs_have_no_success_marker(self):
        output = self.root / "result.md"
        pdf = self.root / "scan.pdf"
        write_pdf(pdf, "")
        self.assertIn("No extractable text or images", self.run_tool(pdf, output, success=False))
        bad = self.root / "broken.docx"
        bad.write_bytes(b"broken")
        self.run_tool(bad, output, success=False)
        unsupported = self.root / "old.doc"
        unsupported.touch()
        self.assertIn("Supported", self.run_tool(unsupported, output, success=False))
        with bad.open("wb") as stream:
            stream.truncate(64 * 1024 * 1024 + 1)
        self.assertIn("64 MiB", self.run_tool(bad, output, success=False))
        self.assertFalse(output.exists())


if __name__ == "__main__":
    if len(sys.argv) == 2:
        SCRIPT = Path(sys.argv.pop()).resolve()
    unittest.main()
