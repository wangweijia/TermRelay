import Foundation
import XCTest
@testable import TermRelay

final class DeviceIdentityTests: XCTestCase {
    func testPackagedAppUsesStandardDefaultsWithoutCreatingForbiddenSuite() throws {
        let suite = "TermRelayTests.packagedPreferences.\(UUID())"
        let standard = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { standard.removePersistentDomain(forName:suite) }
        let originalID = UUID()
        standard.set(originalID.uuidString,forKey:"deviceID")
        standard.set(true,forKey:"aiServiceEnabled")
        var suiteRequested = false
        let result = DeviceIdentity.resolvePreferences(bundleIdentifier:"com.termrelay.mac",standard:standard,makeSuite:{ _ in
            suiteRequested = true
            return nil
        })
        XCTAssertFalse(suiteRequested)
        XCTAssertTrue(result === standard)
        XCTAssertTrue(result.bool(forKey:"aiServiceEnabled"))
        XCTAssertEqual(DeviceIdentity.load(defaults:result,hardwareID:"same-mac"),originalID)
    }

    func testUnavailableSuiteFallsBackWithoutChangingDeviceID() throws {
        let suite = "TermRelayTests.unavailablePreferences.\(UUID())"
        let standard = try XCTUnwrap(UserDefaults(suiteName:suite))
        defer { standard.removePersistentDomain(forName:suite) }
        let originalID = UUID()
        standard.set(originalID.uuidString,forKey:"deviceID")
        let result = DeviceIdentity.resolvePreferences(bundleIdentifier:nil,standard:standard,makeSuite:{ _ in nil })
        XCTAssertTrue(result === standard)
        XCTAssertEqual(DeviceIdentity.load(defaults:result,hardwareID:"same-mac"),originalID)
    }

    func testDevelopmentLaunchMigratesPreferencesWithoutOverwritingFixedIdentity() throws {
        let suites = ["TermRelayTests.oldPreferences.\(UUID())","TermRelayTests.fixedPreferences.\(UUID())"]
        let standard = try XCTUnwrap(UserDefaults(suiteName:suites[0]))
        let fixed = try XCTUnwrap(UserDefaults(suiteName:suites[1]))
        defer { standard.removePersistentDomain(forName:suites[0]); fixed.removePersistentDomain(forName:suites[1]) }
        let originalID = UUID()
        fixed.set(originalID.uuidString,forKey:"deviceID")
        standard.set(UUID().uuidString,forKey:"deviceID")
        standard.set("ws://example.test:3007/ws/client",forKey:"serverURL")
        let result = DeviceIdentity.resolvePreferences(bundleIdentifier:"swiftpm.executable",standard:standard,makeSuite:{ name in
            XCTAssertEqual(name,"com.termrelay.mac")
            return fixed
        })
        XCTAssertTrue(result === fixed)
        XCTAssertEqual(result.string(forKey:"serverURL"),standard.string(forKey:"serverURL"))
        XCTAssertEqual(DeviceIdentity.load(defaults:result,hardwareID:nil),originalID)
    }

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
