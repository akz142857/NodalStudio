import Foundation
import CryptoKit

@main struct PurchaseTests {
    static func main() {
        let nonce = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
        let device = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
        let digest = Data(SHA384.hash(data: Data((nonce.uuidString.lowercased() + device.uuidString.lowercased()).utf8)))
        func check(_ bundle: String = "com.example.app", expected: String? = "com.example.app", environment: String = "Production", id: UUID? = device, proof: Data? = nil) -> PurchaseReply {
            validateIdentity(bundle: bundle, expected: expected, environment: environment, nonce: nonce, deviceID: id, digest: proof ?? digest)
        }
        precondition(check().state == "verified")
        precondition(check("com.attacker.app").reason == "identityMismatch")
        precondition(check(expected: nil).state != "verified")
        precondition(check(id: nil).reason == "deviceUnavailable")
        precondition(check(id: UUID()).reason == "deviceMismatch")
        precondition(check(proof: Data()).reason == "deviceMismatch")
        precondition(check(environment: "Sandbox").state == "verified")
        precondition(check(environment: "Sandbox", id: UUID()).state != "verified")
        precondition(check(environment: "Xcode").state != "verified")
        precondition(check(environment: "Unknown").state != "verified")
        let uppercase = Data(SHA384.hash(data: Data((nonce.uuidString + device.uuidString).utf8)))
        precondition(check(proof: uppercase).state != "verified")
        print("11 native purchase identity/device/environment policy checks passed (synthetic; not an Apple purchase).")
    }
}
