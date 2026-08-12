import { strToU8, zipSync } from "fflate";

export type ExportTable = {
  name: string;
  rows: string[][];
};

function cleanMarkdownCell(value: string) {
  return value
    .trim()
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\\|/g, "|")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function splitMarkdownRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;

  const source = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "\\" && next === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cleanMarkdownCell(current));
      current = "";
    } else {
      current += character;
    }
  }

  cells.push(cleanMarkdownCell(current));
  return cells;
}

function isSeparatorRow(cells: string[]) {
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))
  );
}

function cleanHeading(value: string) {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[一二三四五六七八九十0-9]+[、.．]\s*/, "")
    .trim();
}

function normalizeRows(rows: string[][]) {
  const width = rows[0]?.length ?? 0;
  return rows.map((row) => {
    if (row.length >= width) return row.slice(0, width);
    return [...row, ...Array.from({ length: width - row.length }, () => "")];
  });
}

export function parseMarkdownTables(markdown: string): ExportTable[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const tables: ExportTable[] = [];
  let latestHeading = "";

  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index].trim().match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      latestHeading = cleanHeading(headingMatch[1]);
      continue;
    }

    const header = splitMarkdownRow(lines[index]);
    const separator = splitMarkdownRow(lines[index + 1] ?? "");
    if (!header || !separator || !isSeparatorRow(separator)) continue;

    const rows = [header];
    index += 2;
    while (index < lines.length) {
      const row = splitMarkdownRow(lines[index]);
      if (!row) break;
      rows.push(row);
      index += 1;
    }
    index -= 1;

    tables.push({
      name: latestHeading || `分析表 ${tables.length + 1}`,
      rows: normalizeRows(rows),
    });
  }

  return tables;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelColumnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function normalizeSheetName(value: string, fallback: string) {
  const name = value.replace(/[\\/*?:[\]]/g, " ").replace(/\s+/g, " ").trim();
  return (name || fallback).slice(0, 31);
}

function uniqueSheetNames(tables: ExportTable[]) {
  const used = new Set<string>();
  return tables.map((table, index) => {
    const base = normalizeSheetName(table.name, `分析表 ${index + 1}`);
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const suffixText = ` ${suffix}`;
      name = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function displayWidth(value: string) {
  return Array.from(value).reduce(
    (width, character) => width + (/[\u0000-\u00ff]/.test(character) ? 1 : 2),
    0,
  );
}

function worksheetXml(rows: string[][]) {
  const rowCount = rows.length;
  const columnCount = rows[0]?.length ?? 1;
  const finalColumn = excelColumnName(Math.max(columnCount - 1, 0));
  const finalCell = `${finalColumn}${Math.max(rowCount, 1)}`;

  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const longest = rows.reduce(
      (max, row) => Math.max(max, displayWidth(row[columnIndex] ?? "")),
      0,
    );
    return Math.min(42, Math.max(10, longest + 2));
  });

  const columns = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");

  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${excelColumnName(columnIndex)}${rowIndex + 1}`;
          const style = rowIndex === 0 ? 1 : 2;
          return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      const height = rowIndex === 0 ? 26 : 42;
      return `<row r="${rowIndex + 1}" ht="${height}" customHeight="1">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${finalCell}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columns}</cols>
  <sheetData>${sheetRows}</sheetData>
  <autoFilter ref="A1:${finalCell}"/>
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Microsoft YaHei"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD9E2EA"/></left>
      <right style="thin"><color rgb="FFD9E2EA"/></right>
      <top style="thin"><color rgb="FFD9E2EA"/></top>
      <bottom style="thin"><color rgb="FFD9E2EA"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1" applyFill="1" applyFont="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

export function buildWorkbookFromTables(tables: ExportTable[], title: string): Uint8Array {
  if (!tables.length) {
    throw new Error("没有识别到可导出的分析表格。");
  }

  const sheetNames = uniqueSheetNames(tables);
  const worksheetRelationships = tables
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  const styleRelationshipId = tables.length + 1;
  const now = new Date().toISOString();

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${tables.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>产品分析助手</dc:creator>
  <cp:lastModifiedBy>产品分析助手</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`),
    "docProps/app.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>产品分析助手</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <AppVersion>1.0</AppVersion>
</Properties>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
  <sheets>${sheetNames.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>
  <calcPr calcId="191029"/>
</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${worksheetRelationships}
  <Relationship Id="rId${styleRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    "xl/styles.xml": strToU8(stylesXml()),
  };

  tables.forEach((table, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(
      worksheetXml(table.rows),
    );
  });

  return zipSync(files, { level: 6 });
}

export function buildExcelWorkbook(markdown: string, title: string): Uint8Array {
  const tables = parseMarkdownTables(markdown);
  if (!tables.length) {
    throw new Error("没有识别到可导出的分析表格。");
  }
  return buildWorkbookFromTables(tables, title);
}
