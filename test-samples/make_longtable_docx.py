# -*- coding: utf-8 -*-
"""生成「长表格」docx 样本，用于验证表格跨页分页。

用法：python test-samples/make_longtable_docx.py [行数] [输出路径]

为什么单独造样本：用户反馈的那份 API 文档有 7.9MB / 361 页，
本机渲染时 GPU 进程扛不住（无显卡），渲染没结束浏览器就崩了，
拿不到分页结果。这里造一个几 KB、但表格同样超过一页的文档，
既能在真浏览器里跑完，也能覆盖同样的分页路径。
"""
import os
import sys
import zipfile

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""


def build(rows: int) -> str:
    body = []
    body.append(
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
        '<w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>'
        '<w:t>长表格分页测试</w:t></w:r></w:p>'
    )
    body.append(
        '<w:p><w:r><w:t>下面这张表有 %d 行，应当跨页显示，而不是撑成一张长页。</w:t></w:r></w:p>' % rows
    )

    grid = '<w:tblGrid>' + '<w:gridCol w:w="2600"/>' * 1 + '<w:gridCol w:w="5200"/>' + '</w:tblGrid>'
    borders = (
        '<w:tblBorders>'
        + ''.join(
            '<w:%s w:val="single" w:sz="4" w:space="0" w:color="808080"/>' % side
            for side in ("top", "left", "bottom", "right", "insideH", "insideV")
        )
        + '</w:tblBorders>'
    )
    tbl_pr = (
        '<w:tblPr><w:tblW w:w="7800" w:type="dxa"/>' + borders + '</w:tblPr>'
    )

    trs = []
    # 表头行：用 tblHeader 标记，Word 里跨页会重复（docx-preview 不重复，这里只验证不崩）
    trs.append(
        '<w:tr><w:trPr><w:tblHeader/></w:trPr>'
        '<w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>序号</w:t></w:r></w:p></w:tc>'
        '<w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>说明</w:t></w:r></w:p></w:tc></w:tr>'
    )
    for i in range(1, rows + 1):
        trs.append(
            '<w:tr>'
            '<w:tc><w:p><w:r><w:t>%d</w:t></w:r></w:p></w:tc>'
            '<w:tc><w:p><w:r><w:t>这是第 %d 行的内容，用来把表格撑到超过一页，'
            '从而验证分页是否按行断开。</w:t></w:r></w:p></w:tc>'
            '</w:tr>' % (i, i)
        )

    body.append('<w:tbl><w:tblPr>' + tbl_pr[len('<w:tblPr>'):].replace('</w:tblPr>', '') + '</w:tblPr>'
                + grid + ''.join(trs) + '</w:tbl>')
    body.append('<w:p><w:r><w:t>表格之后的段落（应当紧接在最后一页的表格后面）。</w:t></w:r></w:p>')
    body.append(
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
        'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
    )

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document ' + W + '><w:body>' + ''.join(body) + '</w:body></w:document>'
    )


def main():
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 45
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "longtable.docx")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", build(rows))

    print("已生成 %s（%d 行表格，%.1f KB）" % (out, rows, os.path.getsize(out) / 1024))


if __name__ == "__main__":
    main()
