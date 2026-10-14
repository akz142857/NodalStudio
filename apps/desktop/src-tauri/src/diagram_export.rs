use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::export_file::{MAX_EXPORT_BYTES, save_bytes};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagramFormat {
    Svg,
    Png,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramExportInput {
    pub file_name: String,
    pub format: DiagramFormat,
    pub data: Vec<u8>,
}

#[derive(Serialize)]
pub struct DiagramExportReceipt {
    pub path: String,
}

/// Save only a generated diagram in Downloads, without replacing an existing file.
pub fn save(input: &DiagramExportInput, directory: &Path) -> Result<DiagramExportReceipt, String> {
    let extension = match input.format {
        DiagramFormat::Svg => "svg",
        DiagramFormat::Png => "png",
    };
    if input.data.is_empty() || input.data.len() > MAX_EXPORT_BYTES {
        return Err("The diagram export must be smaller than 32 MB.".into());
    }
    let valid = match input.format {
        DiagramFormat::Svg => std::str::from_utf8(&input.data)
            .is_ok_and(|text| text.starts_with("<svg ") && text.ends_with("</svg>")),
        DiagramFormat::Png => input.data.starts_with(b"\x89PNG\r\n\x1a\n"),
    };
    if !valid {
        return Err("The generated diagram does not match its file format.".into());
    }
    save_bytes(&input.file_name, &input.data, extension, directory)
        .map(|path| DiagramExportReceipt { path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn svg_input(file_name: &str) -> DiagramExportInput {
        DiagramExportInput {
            file_name: file_name.into(),
            format: DiagramFormat::Svg,
            data: b"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Diagram</text></svg>".to_vec(),
        }
    }

    #[test]
    fn saves_exports_without_overwriting_existing_files() {
        let directory =
            std::env::temp_dir().join(format!("nodal-diagram-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let input = svg_input("model.svg");
        let first = save(&input, &directory).unwrap();
        let second = save(&input, &directory).unwrap();
        assert!(first.path.ends_with("model.svg"));
        assert!(second.path.ends_with("model-1.svg"));
        assert_eq!(fs::read(&first.path).unwrap(), input.data);
        let png = DiagramExportInput {
            file_name: "model.png".into(),
            format: DiagramFormat::Png,
            data: b"\x89PNG\r\n\x1a\nfixture".to_vec(),
        };
        let receipt = save(&png, &directory).unwrap();
        assert_eq!(fs::read(receipt.path).unwrap(), png.data);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_paths_wrong_formats_and_oversized_payloads_before_writing() {
        let directory = std::env::temp_dir();
        for name in [
            "../model.svg",
            "/tmp/model.svg",
            "sub/model.svg",
            "model.png",
            ".hidden.svg",
            "model:bad.svg",
        ] {
            assert!(save(&svg_input(name), &directory).is_err());
        }
        let mut input = svg_input("model.svg");
        input.data = b"<html>not an SVG</html>".to_vec();
        assert!(save(&input, &directory).is_err());
        input.data = vec![0; MAX_EXPORT_BYTES + 1];
        assert!(save(&input, &directory).is_err());
    }
}
