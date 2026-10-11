import Foundation
import XCTest
@testable import TermRelay

final class DeviceIdentityTests: XCTestCase {
    func testStoredIdentitySurvivesRecreatedPreferencesAndChangingHardwareProbe() throws {
        let suite = "TermRelayTests.identity.\(UUID())"
        let first = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { first.removePersistentDomain(forName:suite) }
        let old = UUID()
        first.set(old.uuidString,forKey:"deviceID")
        XCTAssertEqual(DeviceIdentity.load(defaults:first,hardwareID:"hardware-a"),old)
        let reopened = try XCTUnwrap(UserDefaults(suiteName:suite))
        XCTAssertEqual(DeviceIdentity.load(defaults:reopened,hardwareID:"hardware-b"),old)
    }

    func testSameMacGetsSameIdentityAcrossLaunchDomains() throws {
        let suites = ["TermRelayTests.dev.\(UUID())","TermRelayTests.bundle.\(UUID())"]
        let a = try XCTUnwrap(UserDefaults(suiteName:suites[0]))
        let b = try XCTUnwrap(UserDefaults(suiteName:suites[1]))
        defer { a.removePersistentDomain(forName:suites[0]); b.removePersistentDomain(forName:suites[1]) }
        let first = DeviceIdentity.load(defaults:a,hardwareID:"SAME-MAC")
        XCTAssertEqual(first,DeviceIdentity.load(defaults:b,hardwareID:"same-mac"))
        XCTAssertNotEqual(first,DeviceIdentity.derive("another-mac"))
    }

    func testInvalidStoredIdentityIsReplacedWithStableIdentity() throws {
        let suite = "TermRelayTests.invalidIdentity.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { defaults.removePersistentDomain(forName:suite) }
        defaults.set("not-a-uuid",forKey:"deviceID")
        let id = DeviceIdentity.load(defaults:defaults,hardwareID:"same-mac")
        XCTAssertEqual(id,DeviceIdentity.load(defaults:defaults,hardwareID:nil))
        XCTAssertEqual(defaults.string(forKey:"deviceID"),id.uuidString)
    }
}
