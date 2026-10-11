import Foundation
import CryptoKit
import IOKit

enum DeviceIdentity {
    // A fixed domain is shared by SwiftPM launches and packaged App launches.
    static var preferences: UserDefaults {
        let fixed = UserDefaults(suiteName:"com.termrelay.mac")!
        if !fixed.bool(forKey:"fixedPreferencesMigrated") {
            for key in ["deviceID","serverURL","workspaceIDs","codexInteractionMode","acpSendShortcut","toolExecutablePaths","toolProxyConfigurations"] {
                if fixed.object(forKey:key) == nil, let value = UserDefaults.standard.object(forKey:key) { fixed.set(value,forKey:key) }
            }
            fixed.set(true,forKey:"fixedPreferencesMigrated")
            fixed.synchronize()
        }
        return fixed
    }

    static func load(defaults: UserDefaults, hardwareID: String? = hardwareIdentifier()) -> UUID {
        if let stored = defaults.string(forKey:"deviceID"), let id = UUID(uuidString:stored) { return id }
        // Hardware-derived fallback remains stable even when the launch bundle/domain changes.
        let id = hardwareID.map(derive) ?? UUID()
        defaults.set(id.uuidString,forKey:"deviceID")
        defaults.synchronize()
        return id
    }

    static func derive(_ hardwareID: String) -> UUID {
        var bytes = Array(Insecure.SHA1.hash(data:Data("TermRelay.device.v1:\(hardwareID.lowercased())".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid:(bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
    }

    static func hardwareIdentifier() -> String? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault,IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        return IORegistryEntryCreateCFProperty(service,"IOPlatformUUID" as CFString,kCFAllocatorDefault,0)?.takeRetainedValue() as? String
    }
}
