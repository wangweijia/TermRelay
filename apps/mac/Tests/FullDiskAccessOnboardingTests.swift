import Foundation
import XCTest
@testable import TermRelay

final class FullDiskAccessOnboardingTests: XCTestCase {
    func testClaimsPresentationOnlyOnce() throws {
        let suiteName = "FullDiskAccessOnboardingTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertTrue(FullDiskAccessOnboarding.claimFirstPresentation(defaults: defaults))
        XCTAssertFalse(FullDiskAccessOnboarding.claimFirstPresentation(defaults: defaults))
    }

    func testUsesFullDiskAccessSystemSettingsPane() {
        XCTAssertEqual(
            FullDiskAccessOnboarding.systemSettingsURL.absoluteString,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        )
    }
}
