import pathlib
import tempfile
import unittest

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE

from resume_parser_sidecar import extract_docx_text, iter_docx_block_text, repair_pdf_token_wraps


class DocxBlockTextTests(unittest.TestCase):
    def test_preserves_header_and_interleaved_table_order_and_nested_cells(self):
        document = Document()
        document.sections[0].header.paragraphs[0].text = "Jordan Example"
        document.add_paragraph("Experience")
        table = document.add_table(rows=1, cols=1)
        table.cell(0, 0).text = "First role"
        table.cell(0, 0).add_table(rows=1, cols=1).cell(0, 0).text = "2020 - 2022"
        document.add_paragraph("Education")
        document.add_table(rows=1, cols=1).cell(0, 0).text = "Example College"
        self.assertEqual(iter_docx_block_text(document), ["Jordan Example", "Experience", "First role", "2020 - 2022", "Education", "Example College"])

    def test_preserves_hyperlink_label_and_destination(self):
        document = Document()
        paragraph = document.add_paragraph("Contact: ")
        link = OxmlElement("w:hyperlink")
        link.set(qn("r:id"), paragraph.part.relate_to("https://example.test/jordan", RELATIONSHIP_TYPE.HYPERLINK, is_external=True))
        run = OxmlElement("w:r")
        text = OxmlElement("w:t")
        text.text = "Portfolio"
        run.append(text)
        link.append(run)
        paragraph._p.append(link)
        self.assertEqual(iter_docx_block_text(document), ["Contact: Portfolio (https://example.test/jordan)"])

    def test_preserves_repeated_role_titles_and_locations_in_distinct_paragraphs(self):
        document = Document()
        lines = [
            "Alex Sample",
            "Senior Product Engineer",
            "Amsterdam Netherlands",
            "EXPERIENCE",
            "Sample Labs",
            "Senior Product Engineer",
            "Amsterdam Netherlands",
            "March 2022 - Present",
        ]
        for line in lines:
            document.add_paragraph(line)

        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "synthetic-resume.docx"
            document.save(source)
            text, parser, warnings = extract_docx_text(str(source))

        self.assertEqual(parser, "local_docx")
        self.assertEqual(warnings, [])
        self.assertEqual(text, "\n".join(lines))

    def test_reads_a_linked_header_once_but_preserves_matching_body_text(self):
        document = Document()
        document.sections[0].header.paragraphs[0].text = "Alex Sample"
        document.add_paragraph("Alex Sample")
        document.add_section(WD_SECTION_START.NEW_PAGE)
        self.assertTrue(document.sections[1].header.is_linked_to_previous)

        self.assertEqual(iter_docx_block_text(document).count("Alex Sample"), 2)

    def test_reads_one_merged_cell_once_but_keeps_equal_text_in_distinct_cells(self):
        document = Document()
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).merge(table.cell(0, 1)).text = "Senior Engineer"
        table.cell(1, 0).text = "Amsterdam"
        table.cell(1, 1).text = "Amsterdam"

        self.assertEqual(iter_docx_block_text(document), ["Senior Engineer", "Amsterdam", "Amsterdam"])

    def test_repairs_only_unambiguous_pdf_date_and_url_continuations(self):
        self.assertEqual(repair_pdf_token_wraps("03\n/2022 - present\ngithub.com/jordan-exam\nple\nSUMMARY"), "03/2022 - present\ngithub.com/jordan-example\nSUMMARY")
        self.assertEqual(repair_pdf_token_wraps("https://example.test/jordan\nBuilt reliable systems."), "https://example.test/jordan\nBuilt reliable systems.")
        self.assertEqual(repair_pdf_token_wraps("https://example.test/jordan\nskills"), "https://example.test/jordan\nskills")
        self.assertEqual(repair_pdf_token_wraps("https://example.test\nnext"), "https://example.test\nnext")


if __name__ == "__main__":
    unittest.main()
