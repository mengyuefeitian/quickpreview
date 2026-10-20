# -*- coding: utf-8 -*-
"""生成 QuickPreview 全类型测试样本（纯标准库 + ffmpeg）"""
import os, zlib, struct, zipfile, subprocess, sys

OUT = os.path.dirname(os.path.abspath(__file__))
FFMPEG = r"D:\softDevelop\预览\quick-preview\publish\ffmpeg.exe"


def png(path, w=640, h=400):
    # 简单彩色渐变 + 色块，便于肉眼确认渲染
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0
        for x in range(w):
            if (x // 80 + y // 80) % 2 == 0:
                r, g, b = (220, 80, 60) if x < w // 2 else (60, 120, 220)
            else:
                r, g, b = (int(255 * x / w), int(255 * y / h), 180)
            raw += bytes((r, g, b))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # RGB 8bit
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))
    open(path, "wb").write(data)
    print("PNG ->", path, os.path.getsize(path))


def txt(path):
    open(path, "w", encoding="utf-8").write(
        "QuickPreview 文本预览测试\n"
        "第二行：中文内容，验证编码与换行。\n"
        + "\n".join(f"第 {i} 行 line {i} —— 用于验证滚动与行号。" for i in range(3, 60))
    )
    print("TXT ->", path)


def docx(path):
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>')
    paras = "".join(
        f'<w:p><w:r><w:t xml:space="preserve">{t}</w:t></w:r></w:p>' for t in [
            "QuickPreview DOCX 预览测试",
            "这是第二段，包含中文、English 与 数字 12345，用于验证 mammoth 渲染。",
            "第三段：加粗与斜体文本也应正常呈现。",
        ] + [f"正文段落 {i}：用于验证长文档滚动。" for i in range(4, 40)])
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body>' + paras + '<w:sectPr/></w:body></w:document>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
    print("DOCX ->", path, os.path.getsize(path))


def xlsx(path):
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>')
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
    wbrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
              '</Relationships>')
    rows = []
    header = ["姓名", "部门", "季度", "金额", "备注"]
    rows.append(header)
    for i in range(1, 60):
        rows.append([f"员工{i}", "研发部" if i % 2 else "市场部", f"Q{(i % 4) + 1}",
                     str(1000 + i * 37), f"备注 {i}"])
    def col(n):
        s = ""
        while n > 0:
            n, r = divmod(n - 1, 26)
            s = chr(65 + r) + s
        return s
    def esc(v):
        return (str(v).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    body = ""
    for ri, row in enumerate(rows, start=1):
        cells = ""
        for ci, v in enumerate(row, start=1):
            ref = f"{col(ci)}{ri}"
            if ri > 1 and ci == 4:
                cells += f'<c r="{ref}"><v>{esc(v)}</v></c>'
            else:
                cells += f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{esc(v)}</t></is></c>'
        body += f'<row r="{ri}">{cells}</row>'
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetData>' + body + '</sheetData></worksheet>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", wbrels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    print("XLSX ->", path, os.path.getsize(path))


def pptx(path):
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
          '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
          '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
          '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
          '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
          '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
            '</Relationships>')
    pres = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
            '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>'
            '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>')
    presrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
                '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
                '</Relationships>')
    master = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
              'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
              '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
              '<p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" hlink="hlink" folHlink="folHlink"/>'
              '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>')
    masterrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
                  '</Relationships>')
    layout = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
              'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
              'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
              '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
              '<p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>')
    layoutrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
                  '</Relationships>')

    def shape(sid, name, text, y, size=4000, bold=False, color="FF333333"):
        b = '<a:b/>' if bold else '<a:b val="0"/>'
        return ('<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
                '<p:spPr><a:xfrm><a:off x="838200" y="%d"/><a:ext cx="10515600" cy="1500000"/></a:xfrm>'
                '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
                # 注意：a:b 必须作为 a:rPr 的【子元素】，早期版本误拼成属性位置
                # （<a:rPr ... <a:b/> dirty="0">），生成的是非法 XML，DOMParser 解析失败
                # 会导致整页渲染不出任何内容。改回子元素后样本才真正可用。
                '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="%d" dirty="0">%s'
                '<a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:rPr><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>'
                % (sid, name, y, size, b, color, text))

    def slide(texts):
        sp = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
        for i, t in enumerate(texts):
            sp += shape(i + 2, f"TextBox {i+1}", t[0], t[1], t[2], t[3])
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
                'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
                '<p:cSld><p:spTree>' + sp + '</p:spTree></p:cSld>'
                '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>')

    sl1 = slide([("QuickPreview PPTX 预览测试", 800000, 4400, True),
                 ("第二页内容见右侧翻页 →", 2000000, 2800, False),
                 ("中文 / English / 123", 2900000, 2400, False)])
    sl2 = slide([("第二页：验证翻页能力", 800000, 4400, True),
                 ("如果你能看到这行，说明 PPTX 多页渲染正常。", 2000000, 2800, False)])
    slrels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
              '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
              '</Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("ppt/presentation.xml", pres)
        z.writestr("ppt/_rels/presentation.xml.rels", presrels)
        z.writestr("ppt/slideMasters/slideMaster1.xml", master)
        z.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", masterrels)
        z.writestr("ppt/slideLayouts/slideLayout1.xml", layout)
        z.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layoutrels)
        z.writestr("ppt/slides/slide1.xml", sl1)
        z.writestr("ppt/slides/_rels/slide1.xml.rels", slrels)
        z.writestr("ppt/slides/slide2.xml", sl2)
        z.writestr("ppt/slides/_rels/slide2.xml.rels", slrels)
    print("PPTX ->", path, os.path.getsize(path))


def pdf(path):
    # 两页极简 PDF，中文用 WinAnsi 无法表达，这里用英文+数字，另附中文注释行（PDF 非强要求）
    texts = [
        "QuickPreview PDF preview test - page 1",
        "QuickPreview PDF preview test - page 2",
    ]
    objs = []
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>")

    def page(i):
        return (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                f"/Resources << /Font << /F1 7 0 R >> >> /Contents {4 + i * 2} 0 R >>")

    def content(t):
        s = f"BT /F1 24 Tf 72 760 Td ({t}) Tj ET\n"
        s += "BT /F1 14 Tf 72 720 Td (If you can read this, pdf.js works.) Tj ET\n"
        s += "0.9 0.3 0.2 RG 2 w 72 700 m 523 700 l S\n"
        return f"<< /Length {len(s)} >>\nstream\n{s}endstream"

    objs.append(page(0))
    objs.append(content(texts[0]))
    objs.append(page(1))
    objs.append(content(texts[1]))
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("latin-1")
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("latin-1")
    open(path, "wb").write(out)
    print("PDF ->", path, os.path.getsize(path))


def ffmpeg(args, label):
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"] + args
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print(f"[FAIL] {label}: {r.stderr.decode('utf-8', 'ignore')[:400]}")
    else:
        print(f"[OK] {label}")


def media():
    dur = ["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-f", "lavfi",
           "-i", "testsrc=size=640x360:rate=25:duration=5"]
    base = os.path.join(OUT, "sample.mp4.tmp")
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=5",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            os.path.join(OUT, "sample.mp4")], "MP4")
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=5",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            os.path.join(OUT, "sample.mkv")], "MKV")
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "libmp3lame",
            os.path.join(OUT, "sample.mp3")], "MP3")
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "flac",
            os.path.join(OUT, "sample.flac")], "FLAC")
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "ape",
            os.path.join(OUT, "sample.ape")], "APE")


if __name__ == "__main__":
    png(os.path.join(OUT, "sample.png"))
    txt(os.path.join(OUT, "sample.txt"))
    docx(os.path.join(OUT, "sample.docx"))
    xlsx(os.path.join(OUT, "sample.xlsx"))
    pptx(os.path.join(OUT, "sample.pptx"))
    pdf(os.path.join(OUT, "sample.pdf"))
    media()
    print("done")
