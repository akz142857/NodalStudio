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

/// Keep the binary path subject to the same format, filename, size and exclusive
/// create checks as the legacy JSON command. Reject before copying the body.
pub fn from_binary(
    body: &tauri::ipc::InvokeBody,
    headers: &tauri::http::HeaderMap,
) -> Result<DiagramExportInput, String> {
    let tauri::ipc::InvokeBody::Raw(data) = body else {
        return Err("Expected binary diagram data.".into());
    };
    if data.is_empty() || data.len() > MAX_EXPORT_BYTES {
        return Err("The diagram export must be smaller than 32 MB.".into());
    }
    let file_name = headers
        .get("x-nodal-file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing diagram filename.")?;
    // Export filenames are already restricted to ASCII by save_bytes.
    if file_name.len() > 180
        || file_name.is_empty()
        || !file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        || file_name.starts_with('.')
    {
        return Err("Choose a valid export filename.".into());
    }
    let format = match (
        headers
            .get("x-nodal-format")
            .and_then(|value| value.to_str().ok()),
        Path::new(file_name)
            .extension()
            .and_then(|value| value.to_str()),
    ) {
        (Some("svg"), Some("svg")) => DiagramFormat::Svg,
        (Some("png"), Some("png")) => DiagramFormat::Png,
        _ => return Err("The diagram format and filename must match.".into()),
    };
    Ok(DiagramExportInput {
        file_name: file_name.to_owned(),
        format,
        data: data.clone(),
    })
}

/// Save only a generated diagram in the selected directory, without replacing an existing file.
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

    fn binary_headers(name: &str, format: &str) -> tauri::http::HeaderMap {
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("x-nodal-file-name", name.parse().unwrap());
        headers.insert("x-nodal-format", format.parse().unwrap());
        headers
    }

    #[test]
    fn binary_payload_uses_the_same_exclusive_save_and_exact_bytes() {
        let directory = std::env::temp_dir().join(format!("nodal-binary-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let bytes = svg_input("model.svg").data;
        let body = tauri::ipc::InvokeBody::Raw(bytes.clone());
        let input = from_binary(&body, &binary_headers("model.svg", "svg")).unwrap();
        let first = save(&input, &directory).unwrap();
        let second = save(&input, &directory).unwrap();
        assert_eq!(fs::read(first.path).unwrap(), bytes);
        assert!(second.path.ends_with("model-1.svg"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn binary_payload_rejects_invalid_metadata_sizes_and_wrong_formats() {
        let body = tauri::ipc::InvokeBody::Raw(svg_input("model.svg").data);
        for (name, format) in [
            ("../model.svg", "svg"),
            ("a/model.svg", "svg"),
            (".model.svg", "svg"),
            ("model.png", "svg"),
            ("model.svg", "html"),
            ("", "svg"),
        ] {
            assert!(from_binary(&body, &binary_headers(name, format)).is_err());
        }
        assert!(from_binary(&body, &tauri::http::HeaderMap::new()).is_err());
        let headers = binary_headers("model.svg", "svg");
        for body in [
            tauri::ipc::InvokeBody::Raw(vec![]),
            tauri::ipc::InvokeBody::Raw(vec![0; MAX_EXPORT_BYTES + 1]),
            tauri::ipc::InvokeBody::Json(serde_json::json!({"data": []})),
        ] {
            assert!(from_binary(&body, &headers).is_err());
        }
        let wrong = from_binary(&body, &binary_headers("model.png", "png")).unwrap();
        assert!(save(&wrong, &std::env::temp_dir()).is_err());
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
