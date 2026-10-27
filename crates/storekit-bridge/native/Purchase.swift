import Foundation
import StoreKit
import CryptoKit

// No receipt, account identifier or device identifier crosses into the WebView.
struct PurchaseReply: Codable, Sendable {
    let state: String
    let reason: String?
    let environment: String?
    static func failure(_ reason: String, invalid: Bool = false) -> Self {
        Self(state: invalid ? "unverified" : "needsRecovery", reason: reason, environment: nil)
    }
}

// Shared by production validation and native policy tests. Called only AFTER
// StoreKit verifies the signature. No decoded/cached JWS can call the IPC directly.
func validateIdentity(bundle: String, expected: String?, environment: String,
                      nonce: UUID, deviceID: UUID?, digest: Data) -> PurchaseReply {
    guard let expected, !expected.isEmpty, bundle == expected else {
        return .failure("identityMismatch", invalid: true)
    }
    guard environment == "Production" || environment == "Sandbox" else {
        return .failure("environmentMismatch", invalid: true)
    }
    guard let deviceID else { return .failure("deviceUnavailable") }
    let bytes = Data((nonce.uuidString.lowercased() + deviceID.uuidString.lowercased()).utf8)
    guard Data(SHA384.hash(data: bytes)) == digest else {
        return .failure("deviceMismatch", invalid: true)
    }
    return PurchaseReply(state: "verified", reason: nil, environment: environment)
}

@available(macOS 13.0, *)
func readPurchase(refresh: Bool, expectedBundle: String) async -> PurchaseReply {
    guard Bundle.main.bundleIdentifier == expectedBundle else {
        return .failure("identityMismatch", invalid: true)
    }
    do {
        let result = try await (refresh ? AppTransaction.refresh() : AppTransaction.shared)
        switch result {
        case .unverified:
            return .failure("verificationFailed", invalid: true)
        case .verified(let transaction):
            // New SDKs expose this field as revocationDate; inspect only the
            // Apple-verified payload so older SDK builds can also reject it.
            guard let payload = try? JSONSerialization.jsonObject(with: transaction.jsonRepresentation) as? [String: Any] else {
                return .failure("verificationFailed", invalid: true)
            }
            if let revoked = payload["appRevocationDate"], !(revoked is NSNull) {
                return .failure("revoked", invalid: true)
            }
            return validateIdentity(bundle: transaction.bundleID,
                expected: expectedBundle,
                environment: transaction.environment.rawValue,
                nonce: transaction.deviceVerificationNonce, deviceID: AppStore.deviceVerificationID,
                digest: transaction.deviceVerification)
        }
    } catch StoreKitError.userCancelled { return .failure("cancelled") }
      catch StoreKitError.networkError { return .failure("networkUnavailable") }
      catch StoreKitError.notEntitled { return .failure("notEntitled", invalid: true) }
      catch { return .failure("storeUnavailable") }
}

// A timeout must not leave a callback pointing into a freed Rust stack. This
// independently retained box owns the completion until the Swift task finishes.
final class ReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var reply: PurchaseReply = .failure("timeout")
    func set(_ value: PurchaseReply) { lock.lock(); defer { lock.unlock() }; reply = value }
    func get() -> PurchaseReply { lock.lock(); defer { lock.unlock() }; return reply }
}

@_cdecl("nodal_purchase_check")
public func nodalPurchaseCheck(_ refresh: Int32, _ expected: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard #available(macOS 13.0, *) else { return strdup("{\"state\":\"unsupported\",\"reason\":\"unsupportedSystem\"}") }
    guard let expected else { return nil }
    let expectedBundle = String(cString: expected)
    let box = ReplyBox()
    let finished = DispatchSemaphore(value: 0)
    let task = Task.detached {
        box.set(await readPurchase(refresh: refresh != 0, expectedBundle: expectedBundle))
        finished.signal()
    }
    // Interactive Apple authentication gets longer; neither blocks the UI thread.
    let completed = finished.wait(timeout: .now() + (refresh != 0 ? 120 : 20)) == .success
    if !completed { task.cancel() }
    let reply = completed ? box.get() : .failure("timeout")
    guard let encoded = try? JSONEncoder().encode(reply), let json = String(data: encoded, encoding: .utf8) else { return nil }
    return strdup(json)
}

@_cdecl("nodal_purchase_free")
public func nodalPurchaseFree(_ value: UnsafeMutablePointer<CChar>?) { free(value) }
