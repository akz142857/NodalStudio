import Foundation

// Bookmarks are local app preferences, never exported with a model or settings.
private let bookmarkLock = NSLock()
private let bookmarkKey = "NodalSecurityScopedBookmarksV1"

@_cdecl("nodal_remember_file")
public func nodalRememberFile(_ path: UnsafePointer<CChar>?) -> Int32 {
    guard let path else { return 0 }
    let url = URL(fileURLWithPath: String(cString: path)).standardizedFileURL
    bookmarkLock.lock(); defer { bookmarkLock.unlock() }
    do {
        let data = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
        var bookmarks = UserDefaults.standard.dictionary(forKey: bookmarkKey) as? [String: Data] ?? [:]
        bookmarks[url.path] = data
        UserDefaults.standard.set(bookmarks, forKey: bookmarkKey)
        return 1
    } catch { return 0 }
}

// Each successful acquisition returns one retained URL, released by Rust RAII.
@_cdecl("nodal_access_file")
public func nodalAccessFile(_ path: UnsafePointer<CChar>?) -> UnsafeMutableRawPointer? {
    guard let path else { return nil }
    let requested = URL(fileURLWithPath: String(cString: path)).standardizedFileURL
    bookmarkLock.lock(); defer { bookmarkLock.unlock() }
    var bookmarks = UserDefaults.standard.dictionary(forKey: bookmarkKey) as? [String: Data] ?? [:]
    guard let data = bookmarks[requested.path] else { return nil }
    do {
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        // Do not silently use a replacement path or follow a moved credential.
        guard url.standardizedFileURL.path == requested.path,
              url.startAccessingSecurityScopedResource() else { return nil }
        if stale {
            do {
                bookmarks[requested.path] = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
                UserDefaults.standard.set(bookmarks, forKey: bookmarkKey)
            } catch { url.stopAccessingSecurityScopedResource(); return nil }
        }
        return Unmanaged.passRetained(url as NSURL).toOpaque()
    } catch { return nil }
}

@_cdecl("nodal_release_file")
public func nodalReleaseFile(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    let url = Unmanaged<NSURL>.fromOpaque(handle).takeRetainedValue()
    url.stopAccessingSecurityScopedResource()
}
