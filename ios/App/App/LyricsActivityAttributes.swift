import Foundation
#if canImport(ActivityKit)
import ActivityKit

// The lyrics Live Activity (lock screen and Dynamic Island). Compiled into both the app, which updates
// it (LyricsLiveActivity.swift), and the MurielWidgets extension, which draws it.
// A Live Activity can only be started while the app is open, so one activity follows the whole
// listening session and everything that changes per song lives in the content state.
@available(iOS 16.1, *)
struct MurielLyricsAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String
        var artist: String
        /// the line being sung now; empty before the first line or without synced lyrics
        var line: String
        var next: String
        var playing: Bool
        /// small JPEG cover; the whole activity has to stay under 4 KB
        var artwork: Data?
        /// length of the song in seconds, 0 when not known yet
        var duration: Double = 0
        /// where the song is (paused). While it plays, `start` is when it was at 0:00, so the progress
        /// bar and the time move by themselves without an update every second.
        var position: Double = 0
        var start: Date? = nil
        var shuffle: Bool = false
    }
}
#endif

#if canImport(AppIntents)
import AppIntents

/// The buttons in the Dynamic Island (iOS 17+): iOS runs this inside the app, which hands it to the page
/// (LyricsLiveActivity.swift → mobile/live-activity.js).
@available(iOS 17.0, *)
struct MurielPlayerIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Control Muriel"
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Action") var action: String

    init() {}
    init(action: String) { self.action = action }

    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: Notification.Name("MurielPlayerAction"), object: nil, userInfo: ["action": action])
        return .result()
    }
}
#endif
