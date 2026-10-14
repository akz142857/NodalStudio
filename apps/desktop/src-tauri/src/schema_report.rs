use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::export_file::{MAX_EXPORT_BYTES, save_bytes};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaReportExportInput {
    pub file_name: String,
    pub html: String,
}

#[derive(Serialize)]
pub struct SchemaReportExportReceipt {
    pub path: String,
}

pub fn save(
    input: &SchemaReportExportInput,
    directory: &Path,
) -> Result<SchemaReportExportReceipt, String> {
    if input.html.len() > MAX_EXPORT_BYTES {
        return Err("The schema report must be smaller than 32 MB.".into());
    }
    if !input.html.starts_with("<!doctype html><html ") || !input.html.ends_with("</html>") {
        return Err("The generated report is not an HTML document.".into());
    }
    save_bytes(&input.file_name, input.html.as_bytes(), "html", directory)
        .map(|path| SchemaReportExportReceipt { path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn report(file_name: &str) -> SchemaReportExportInput {
        SchemaReportExportInput {
            file_name: file_name.into(),
            html: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"></head><body>业务域 &amp; schema</body></html>".into(),
        }
    }

    #[test]
    fn saves_utf8_and_does_not_overwrite_existing_reports() {
        let directory = std::env::temp_dir().join(format!("nodal-report-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let input = report("schema.html");
        let first = save(&input, &directory).unwrap();
        let second = save(&input, &directory).unwrap();
        assert!(first.path.ends_with("schema.html"));
        assert!(second.path.ends_with("schema-1.html"));
        assert_eq!(fs::read(&first.path).unwrap(), input.html.as_bytes());
        assert_eq!(fs::read(&second.path).unwrap(), input.html.as_bytes());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unsafe_names_invalid_content_and_oversize_without_writing() {
        let directory = std::env::temp_dir().join(format!("nodal-report-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        for name in [
            "../schema.html",
            "/tmp/schema.html",
            "schema.svg",
            ".hidden.html",
            "sub/schema.html",
        ] {
            assert!(save(&report(name), &directory).is_err());
        }
        let mut input = report("schema.html");
        input.html = "not HTML".into();
        assert!(save(&input, &directory).is_err());
        input.html = "a".repeat(MAX_EXPORT_BYTES + 1);
        assert!(save(&input, &directory).is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reports_an_unavailable_destination() {
        let missing = std::env::temp_dir().join(format!("nodal-missing-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            save(&report("schema.html"), &missing).err().unwrap(),
            "The Downloads directory is unavailable."
        );
    }
}
