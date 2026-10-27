use query_engine::{QueryCell, QueryExecutionResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::{
    fs,
    io::{Cursor, Write},
};
use tauri_plugin_dialog::DialogExt;
use zip::{ZipWriter, write::SimpleFileOptions};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Csv,
    Json,
    Xlsx,
}
impl Format {
    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Json => "json",
            Self::Xlsx => "xlsx",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    result: QueryExecutionResult,
    format: Format,
    selected_rows: Option<Vec<usize>>,
    protect_formulas: bool,
}
fn cell_text(cell: &QueryCell) -> String {
    match cell {
        QueryCell::Null => String::new(),
        QueryCell::Boolean { value } => value.to_string(),
        QueryCell::Number { value } => value.to_string(),
        QueryCell::Text { value, truncated } => {
            if *truncated {
                format!("{value} [TRUNCATED]")
            } else {
                value.clone()
            }
        }
        QueryCell::Json {
            value,
            raw,
            truncated,
        } => format!(
            "{}{}",
            raw.clone().unwrap_or_else(|| value.to_string()),
            if *truncated { " [TRUNCATED]" } else { "" }
        ),
        QueryCell::Binary { byte_length } => format!("[BINARY NOT LOADED: {byte_length} bytes]"),
    }
}
fn csv_field(value: &str, protect: bool) -> String {
    let prefix = if protect
        && (value.trim_start().starts_with(['=', '+', '-', '@'])
            || value.starts_with(['\t', '\r', '\n']))
    {
        "'"
    } else {
        ""
    };
    format!("\"{prefix}{}\"", value.replace('"', "\"\""))
}
fn json_cell(cell: &QueryCell) -> Result<Box<serde_json::value::RawValue>, String> {
    let encoded = match cell {
        QueryCell::Null => "null".into(),
        QueryCell::Boolean { value } => value.to_string(),
        QueryCell::Number { value } => value.to_string(),
        QueryCell::Text { value, .. } => json!(value).to_string(),
        QueryCell::Json { value, raw, .. } => raw.clone().unwrap_or_else(|| value.to_string()),
        QueryCell::Binary { byte_length } => {
            json!({"$binaryNotLoaded": true, "byteLength": byte_length}).to_string()
        }
    };
    serde_json::value::RawValue::from_string(encoded).map_err(|_| "Invalid JSON cell.".into())
}
#[derive(Serialize)]
struct JsonExport<'a> {
    metadata: Value,
    columns: &'a [query_engine::QueryColumn],
    rows: Vec<Vec<Box<serde_json::value::RawValue>>>,
}
// SpreadsheetML escaping, including controls and literal OOXML escape sequences.
fn xml(value: &str) -> String {
    let mut out = String::new();
    for (offset, c) in value.char_indices() {
        let tail = &value[offset..];
        if c == '_'
            && tail.len() >= 7
            && tail.as_bytes()[1] == b'x'
            && tail.as_bytes()[2..6].iter().all(u8::is_ascii_hexdigit)
            && tail.as_bytes()[6] == b'_'
        {
            out.push_str("_x005F_");
            continue;
        }
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if (c < ' ' && !matches!(c, '\n' | '\r' | '\t'))
                || matches!(c, '\u{fffe}' | '\u{ffff}') =>
            {
                write!(out, "_x{:04X}_", u32::from(c)).expect("writing to a String");
            }
            _ => out.push(c),
        }
    }
    out
}
fn column_name(mut index: usize) -> String {
    let mut name = String::new();
    loop {
        name.insert(
            0,
            char::from(b'A' + u8::try_from(index % 26).expect("column digit is below 26")),
        );
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name
}
fn string_cell(reference: &str, value: &str) -> Result<String, String> {
    if value.encode_utf16().count() > 32767 {
        return Err("A cell exceeds Excel’s 32,767-character limit. Export JSON or CSV instead; no file was saved.".into());
    }
    Ok(format!(
        "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
        xml(value)
    ))
}
fn xlsx(
    result: &QueryExecutionResult,
    rows: &[usize],
    metadata: &Value,
) -> Result<Vec<u8>, String> {
    let mut sheet = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><sheetData><row r=\"1\">",
    );
    for (c, column) in result.columns.iter().enumerate() {
        sheet.push_str(&string_cell(&format!("{}1", column_name(c)), &column.name)?);
    }
    sheet.push_str("</row>");
    for (r, index) in rows.iter().enumerate() {
        let number = r + 2;
        write!(sheet, "<row r=\"{number}\">").expect("writing to a String");
        for (c, cell) in result.rows[*index].iter().enumerate() {
            let reference = format!("{}{number}", column_name(c));
            match cell {
                QueryCell::Null => {}
                QueryCell::Number { value } => {
                    write!(sheet, "<c r=\"{reference}\"><v>{value}</v></c>")
                        .expect("writing to a String");
                }
                QueryCell::Boolean { value } => {
                    write!(
                        sheet,
                        "<c r=\"{reference}\" t=\"b\"><v>{}</v></c>",
                        u8::from(*value)
                    )
                    .expect("writing to a String");
                }
                _ => sheet.push_str(&string_cell(&reference, &cell_text(cell))?),
            }
        }
        sheet.push_str("</row>");
    }
    sheet.push_str("</sheetData></worksheet>");
    let mut info = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>",
    );
    for (r, (key, value)) in metadata
        .as_object()
        .ok_or("Invalid metadata")?
        .iter()
        .enumerate()
    {
        write!(
            info,
            "<row r=\"{}\">{}{}</row>",
            r + 1,
            string_cell(&format!("A{}", r + 1), key)?,
            string_cell(&format!("B{}", r + 1), &value.to_string())?
        )
        .expect("writing to a String");
    }
    info.push_str("</sheetData></worksheet>");
    let files = [
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
        ),
        (
            "xl/workbook.xml",
            r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" r:id="rId1"/><sheet name="Export info" sheetId="2" r:id="rId2"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#,
        ),
        ("xl/worksheets/sheet1.xml", sheet.as_str()),
        ("xl/worksheets/sheet2.xml", info.as_str()),
    ];
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in files {
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .map_err(|e| e.to_string())?;
        zip.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}
pub fn generate(input: &Input) -> Result<Vec<u8>, String> {
    let r = &input.result;
    if r.columns.is_empty()
        || r.columns.len() > 16384
        || r.rows.len() > 5000
        || r.row_count != r.rows.len()
        || r.rows.iter().any(|row| row.len() != r.columns.len())
    {
        return Err("Invalid result shape or export size.".into());
    }
    if serde_json::to_vec(r).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("Result exceeds the 32 MB export input limit.".into());
    }
    let rows = input
        .selected_rows
        .clone()
        .unwrap_or_else(|| (0..r.rows.len()).collect());
    let mut seen = std::collections::HashSet::new();
    if rows.iter().any(|i| *i >= r.rows.len() || !seen.insert(*i)) {
        return Err("The selected rows are no longer available.".into());
    }
    let mut incomplete = Vec::new();
    for (export_row, index) in rows.iter().enumerate() {
        for (column, cell) in r.rows[*index].iter().enumerate() {
            match cell {
                QueryCell::Text {
                    truncated: true, ..
                }
                | QueryCell::Json {
                    truncated: true, ..
                } => incomplete
                    .push(json!({"row": export_row+1, "column":column+1, "reason":"truncated"})),
                QueryCell::Binary { .. } => incomplete.push(
                    json!({"row": export_row+1, "column":column+1, "reason":"binaryNotLoaded"}),
                ),
                QueryCell::Number { value } if !value.is_finite() => {
                    return Err("Non-finite numeric value.".into());
                }
                _ => {}
            }
        }
    }
    let metadata = json!({"scope": if input.selected_rows.is_some() { "Selected rows from current returned result" } else { "All rows in current returned result, including all pages" }, "queryId":r.query_id, "returnedRows":r.rows.len(), "exportedRows":rows.len(), "resultLimited":r.truncated, "notices":r.notices, "incompleteCells":incomplete, "columns":r.columns, "valueEncoding":"Exact integers/decimals and dates remain text; NULL is null in JSON, blank in XLSX, unquoted \\N in CSV. CSV strings are quoted; spreadsheet formula protection may prefix an apostrophe. No query is re-executed."});
    let bytes = match input.format {
        Format::Json => serde_json::to_vec_pretty(&JsonExport {
            metadata,
            columns: &r.columns,
            rows: rows
                .iter()
                .map(|i| r.rows[*i].iter().map(json_cell).collect())
                .collect::<Result<_, _>>()?,
        })
        .map_err(|e| e.to_string())?,
        Format::Csv => {
            let mut csv = String::from("\u{feff}");
            csv.push_str(
                &r.columns
                    .iter()
                    .map(|c| csv_field(&c.name, input.protect_formulas))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            csv.push_str("\r\n");
            for i in rows {
                csv.push_str(
                    &r.rows[i]
                        .iter()
                        .map(|c| {
                            if matches!(c, QueryCell::Null) {
                                "\\N".into()
                            } else {
                                csv_field(
                                    &cell_text(c),
                                    input.protect_formulas
                                        && !matches!(
                                            c,
                                            QueryCell::Number { .. } | QueryCell::Boolean { .. }
                                        ),
                                )
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(","),
                );
                csv.push_str("\r\n");
            }
            csv.into_bytes()
        }
        Format::Xlsx => xlsx(r, &rows, &metadata)?,
    };
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("Generated export exceeds 128 MB. Reduce the result size.".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn export_query_result(
    app: tauri::AppHandle,
    input: Input,
    locale: Option<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = generate(&input)?;
        let extension = input.format.extension();
        if crate::purchase::IS_MAS {
            let Some(folder) = app
                .dialog()
                .file()
                .set_title(if locale.as_deref() == Some("zh-CN") {
                    "选择查询结果导出文件夹"
                } else {
                    "Choose query result export folder"
                })
                .blocking_pick_folder()
            else {
                return Ok(None);
            };
            let folder = folder
                .into_path()
                .map_err(|_| "Choose a local folder.".to_owned())?;
            let name = format!(
                "query-result-{}.{}",
                chrono::Local::now().format("%Y%m%d-%H%M%S"),
                extension
            );
            return crate::export_file::save_bytes_with_limit(
                &name,
                &bytes,
                extension,
                &folder,
                128 * 1024 * 1024,
            )
            .map(Some);
        }

        let Some(file) = app
            .dialog()
            .file()
            .set_title(if locale.as_deref() == Some("zh-CN") {
                "导出当前查询结果"
            } else {
                "Export current query result"
            })
            .set_file_name(format!(
                "query-result-{}.{}",
                chrono::Local::now().format("%Y%m%d-%H%M%S"),
                extension
            ))
            .add_filter(
                if locale.as_deref() == Some("zh-CN") {
                    "查询结果"
                } else {
                    "Query result"
                },
                &[extension],
            )
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        if path.extension().and_then(|s| s.to_str()) != Some(extension) {
            return Err(format!(
                "Use a .{extension} filename for this export format."
            ));
        }
        let temp = path.with_file_name(format!(".nodal-export-{}.tmp", uuid::Uuid::new_v4()));
        let saved = (|| {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            fs::rename(&temp, &path)
        })();
        if saved.is_err() {
            let _ = fs::remove_file(&temp);
            return Err(
                "Unable to save this file. Check the destination and available space.".into(),
            );
        }
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    fn fixture(format: Format) -> Input {
        let text = |s: &str| QueryCell::Text {
            value: s.into(),
            truncated: false,
        };
        Input {
            format,
            selected_rows: None,
            protect_formulas: true,
            result: QueryExecutionResult {
                query_id: uuid::Uuid::nil(),
                columns: [
                    "duplicate",
                    "duplicate",
                    "amount",
                    "payload",
                    "empty",
                    "null",
                    "formula",
                    "multiline",
                ]
                .into_iter()
                .map(|name| query_engine::QueryColumn {
                    name: name.into(),
                    database_type: "text".into(),
                })
                .collect(),
                rows: vec![vec![
                    text("9223372036854775807"),
                    text("0000123"),
                    text("1234567890.123456789"),
                    QueryCell::Json {
                        value: Value::Null,
                        raw: Some(
                            "{\"id\":9223372036854775807,\"amount\":0.123456789123456789}".into(),
                        ),
                        truncated: false,
                    },
                    text(""),
                    QueryCell::Null,
                    text("=1+1"),
                    text("中文,\"quoted\"\nline\u{1}_x0041_"),
                ]],
                row_count: 1,
                truncated: true,
                duration_ms: 1,
                notices: vec!["Row limit reached".into()],
            },
        }
    }
    #[test]
    fn json_preserves_duplicate_columns_exact_numbers_raw_json_and_nulls() {
        let bytes = generate(&fixture(Format::Json)).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("0.123456789123456789"));
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["columns"][0]["name"], value["columns"][1]["name"]);
        assert_eq!(value["rows"][0][0], "9223372036854775807");
        assert_eq!(value["rows"][0][4], "");
        assert_eq!(value["rows"][0][5], Value::Null);
        assert_eq!(value["metadata"]["resultLimited"], true);
    }
    #[test]
    fn csv_quotes_multiline_nulls_and_formula_text() {
        let text = String::from_utf8(generate(&fixture(Format::Csv)).unwrap()).unwrap();
        assert!(text.starts_with('\u{feff}'));
        assert!(text.contains("\"'\u{3d}1+1\""));
        assert!(text.contains("\"\",\\N,"));
        assert!(text.contains("中文,\"\"quoted\"\"\nline"));
    }
    #[test]
    fn xlsx_uses_text_cells_no_formulas_and_valid_package_parts() {
        let bytes = generate(&fixture(Format::Xlsx)).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("9223372036854775807"));
        assert!(xml.contains("1234567890.123456789"));
        assert!(xml.contains("=1+1"));
        assert!(!xml.contains("<f>"));
        assert!(xml.contains("_x0001__x005F_x0041_"));
        assert!(archive.by_name("xl/worksheets/sheet2.xml").is_ok());
        // Optional independent-reader acceptance artifact; no user data.
        if let Ok(directory) = std::env::var("NODAL_EXPORT_TEST_DIR") {
            fs::create_dir_all(&directory).unwrap();
            for (format, extension) in [
                (Format::Csv, "csv"),
                (Format::Json, "json"),
                (Format::Xlsx, "xlsx"),
            ] {
                fs::write(
                    std::path::Path::new(&directory).join(format!("synthetic-export.{extension}")),
                    generate(&fixture(format)).unwrap(),
                )
                .unwrap();
            }
        }
    }
    #[test]
    fn rejects_invalid_selection_and_marks_missing_content() {
        let mut input = fixture(Format::Json);
        input.selected_rows = Some(vec![2]);
        assert!(generate(&input).is_err());
        input.selected_rows = Some(vec![0, 0]);
        assert!(generate(&input).is_err());
        input.selected_rows = Some(vec![0]);
        input.result.rows[0][0] = QueryCell::Binary { byte_length: 42 };
        input.result.rows[0][1] = QueryCell::Text {
            value: "partial".into(),
            truncated: true,
        };
        let value: Value = serde_json::from_slice(&generate(&input).unwrap()).unwrap();
        assert_eq!(
            value["metadata"]["incompleteCells"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(value["rows"][0][0]["byteLength"], 42);
        input.format = Format::Xlsx;
        input.result.rows[0][2] = QueryCell::Text {
            value: "x".repeat(32768),
            truncated: false,
        };
        assert!(generate(&input).unwrap_err().contains("32,767"));
    }
}
