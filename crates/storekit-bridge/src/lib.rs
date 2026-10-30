//! Minimal memory-safe interface to the in-process Swift StoreKit provider.
//! Call on a blocking worker, never the Cocoa main thread.
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn nodal_purchase_check(
        refresh: i32,
        expected_bundle: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_char;
    fn nodal_purchase_free(value: *mut std::ffi::c_char);
}

pub fn check(refresh: bool, expected_bundle: &str) -> Result<String, &'static str> {
    #[cfg(target_os = "macos")]
    {
        let expected =
            std::ffi::CString::new(expected_bundle).map_err(|_| "Invalid bundle identity")?;
        // SAFETY: expected lives for the entire call and Swift copies it before spawning.
        // SAFETY: Swift returns either null or an owned strdup allocation containing
        // NUL-terminated UTF-8. No Rust references cross the ABI. Its paired free
        // is called exactly once after copying, including when UTF-8 decoding fails.
        let pointer = unsafe { nodal_purchase_check(i32::from(refresh), expected.as_ptr()) };
        if pointer.is_null() {
            return Err("StoreKit response allocation failed");
        }
        let result = unsafe { std::ffi::CStr::from_ptr(pointer) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "Invalid StoreKit response");
        unsafe { nodal_purchase_free(pointer) };
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (refresh, expected_bundle);
        Err("StoreKit requires macOS")
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn nodal_remember_file(path: *const std::ffi::c_char) -> i32;
    fn nodal_access_file(path: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn nodal_release_file(handle: *mut std::ffi::c_void);
}

// Opaque retained immutable NSURL. Foundation acquisition and release may occur
// on different worker threads; no Rust pointer is dereferenced or shared.
pub struct FileAccess(#[cfg(target_os = "macos")] usize);
impl Drop for FileAccess {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        // SAFETY: a nonzero handle is owned by this guard, released exactly once.
        unsafe {
            nodal_release_file(self.0 as *mut std::ffi::c_void)
        };
    }
}
pub fn remember_file(path: &str) -> Result<(), &'static str> {
    #[cfg(not(target_os = "macos"))]
    let _ = path;
    #[cfg(target_os = "macos")]
    {
        let path = std::ffi::CString::new(path).map_err(|_| "Invalid file path")?;
        // SAFETY: Swift reads the live C string synchronously and retains no pointer.
        if unsafe { nodal_remember_file(path.as_ptr()) } == 1 {
            return Ok(());
        }
    }
    Err("Unable to save file permission. Choose the file again.")
}
pub fn access_file(path: &str) -> Result<FileAccess, &'static str> {
    #[cfg(not(target_os = "macos"))]
    let _ = path;
    #[cfg(target_os = "macos")]
    {
        let path = std::ffi::CString::new(path).map_err(|_| "Invalid file path")?;
        // SAFETY: Swift returns an owned opaque retained URL or null.
        let handle = unsafe { nodal_access_file(path.as_ptr()) };
        if !handle.is_null() {
            return Ok(FileAccess(handle as usize));
        }
    }
    Err("File permission is missing or expired. Choose the file or folder again.")
}
