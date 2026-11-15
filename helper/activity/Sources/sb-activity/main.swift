import EventKit
import Foundation

let VERSION = "1.0.0"
let SAMPLE_INTERVAL: TimeInterval = 5
let CALENDAR_INTERVAL: TimeInterval = 300
let RETRY_INTERVAL: TimeInterval = 30
let AFK_SECONDS: Double = 180
/// Slack is polled rather than watched: there is no notification for "the user is looking at
/// Activity now". Short enough to catch a visit to the Activity view, cheap enough to not matter --
/// a pass that finds another view open is one tree walk and no request.
let SLACK_INTERVAL: TimeInterval = 30
let MAX_BUFFER = 12 * 60 * 60 / 5  // 12 hours of heartbeats
let EXCLUDED_APP_ID = "excluded"

struct Heartbeat: Encodable {
    var at: String
    var afk: Bool?
    var appId: String?
    var appName: String?
    var title: String?
    var url: String?
    var idleSeconds: Double?
    var paused: Bool?
    var helper: HelperInfo?
}
struct HelperInfo: Encodable { var version: String; var permissions: Permissions }
struct CalendarBody: Encodable { var events: [EventPayload]; var window: CalendarWindow; var calendarsSeen: Int? }

let args = CommandLine.arguments
let once = args.contains("--once")
var serverURL = URL(string: "http://127.0.0.1:3141")!
if let i = args.firstIndex(of: "--server"), i + 1 < args.count, let u = URL(string: args[i + 1]) { serverURL = u }

let dataDir = ProcessInfo.processInfo.environment["SB_DATA_DIR"]
    ?? ("\(NSHomeDirectory())/Library/Application Support/second-brain")
let tokenPath = "\(dataDir)/activity-token"

let sampler = Sampler()
let calendar = CalendarReader()
let slack = SlackReader()
let encoder = JSONEncoder()

func log(_ s: String) { FileHandle.standardError.write("[sb-activity] \(s)\n".data(using: .utf8)!) }

func currentPermissions() -> Permissions {
    Permissions(accessibility: sampler.accessibilityTrusted, calendar: calendar.granted, automation: sampler.automation)
}

// A read-only look at what Slack is showing, for when "nothing is arriving" needs explaining.
// Run from a shell this reports the shell's Accessibility grant, not the launch agent's -- see the
// note in helper_status.
if args.contains("--slack") {
    let anyView = args.contains("--any-view")
    guard let view = slack.openView() else {
        print("cannot read Slack: it is not running, has no window, or Accessibility is not granted")
        exit(1)
    }
    print("Slack is showing: \(view)")
    if view != SlackReader.activityTab && !anyView {
        print("""
        Only the Activity view is read. Every row there is somebody addressing you, whereas a
        channel is full of messages that have nothing to do with you. Open Activity in Slack's left
        rail, or pass --any-view to see what would be read from the view that is open.
        """)
        exit(0)
    }
    let observations = slack.read(requireActivity: !anyView) ?? []
    print("\(observations.count) message(s) readable (Slack renders a viewport, not a feed)")
    for o in observations.prefix(10) {
        print("  \(o.at)  \(o.actorName ?? "?")  \(o.context ?? o.externalId)  \(o.text.prefix(60))")
    }
    if !slack.skipped.isEmpty {
        // Not an error. Slack puts kinds in this view that have never been seen against a real
        // workspace, and naming them is how the next one gets handled deliberately rather than
        // imported on a guess.
        print("row kinds seen but not read: \(slack.skipped.sorted().joined(separator: ", "))")
    }
    // Posting from the diagnostic exists so a read can be confirmed end to end without waiting on
    // the next 30s tick -- and, more to the point, without reinstalling the helper, which voids the
    // Accessibility grant every single time.
    if args.contains("--post"), !observations.isEmpty {
        guard let token = try? String(contentsOfFile: tokenPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            log("no token at \(tokenPath)"); exit(1)
        }
        struct Body: Encodable { var observations: [Observation] }
        let probe = Client(base: serverURL, token: token)
        guard let data = try? JSONEncoder().encode(Body(observations: Array(observations.prefix(500)))),
              let (status, body) = probe.post("/api/ingest/observations", json: data) else {
            log("server not answering on \(serverURL)"); exit(1)
        }
        print("posted: \(status) \(String(data: body.prefix(200), encoding: .utf8) ?? "")")
    }
    exit(0)
}

// Asserts the row parsing against ids captured verbatim from a real workspace. Slack's message list
// mixes messages with date separators, the unread divider and a bottom spacer, all sharing the
// `message-list_` prefix; a separator read as a message becomes "Friday, November 6th" presented as
// something a colleague is waiting on.
if args.contains("--slack-self-check") {
    // Two id schemes, both captured verbatim from a real workspace. The Activity one separates its
    // timestamp with a HYPHEN, and reading it with the channel view's underscore pattern is exactly
    // why the first live run against a view holding eleven mentions reported nothing at all.
    let expected: [(String, String, String)] = [
        ("at_channel-C0A1B2C3D-1794429455.100200", "activity", "1794429455.100200"),
        ("at_channel-C0A1B2C3D-1791486074.100500", "activity", "1791486074.100500"),
        ("at_user-D0L1M2N3O-1794261259.100400", "activity", "1794261259.100400"),
        ("message-list_1793915061.100300", "channel", "1793915061.100300"),
        ("message-list_1794429455.100200", "channel", "1794429455.100200"),
    ]
    for (id, scheme, ts) in expected {
        guard SlackReader.scheme(domId: id) == scheme, SlackReader.timestamp(domId: id) == ts else {
            log("FAIL: \(id) read as \(SlackReader.scheme(domId: id) ?? "nothing")/\(SlackReader.timestamp(domId: id) ?? "-"), wanted \(scheme)/\(ts)")
            exit(1)
        }
    }
    // Furniture and chrome. A date separator read as a message hands the desk "Friday, November
    // 6th" as something a colleague is waiting on.
    let furniture = ["message-list_1793903400000.C0A1B2C3D", "message-list_1794249000000divider",
                     "message-list_bottomSpacer", "activity-inbox", "home", "C0D4E5F6G",
                     "Friday, November 6th", "top-anchor-hack", "activity_search_button"]
    for id in furniture where SlackReader.timestamp(domId: id) != nil {
        log("FAIL: \(id) was read as a message"); exit(1)
    }
    // An unknown kind is reported, not read: a reaction is not an ask, and a card saying somebody
    // is waiting on you for one would be worse than missing it.
    guard SlackReader.scheme(domId: "reaction-C0A1B2C3D-1794429455.100200") == "unknown:reaction",
          SlackReader.timestamp(domId: "reaction-C0A1B2C3D-1794429455.100200") == nil else {
        log("FAIL: an unknown row kind was not held back"); exit(1)
    }
    print("slack self-check ok: \(expected.count) rows across 2 schemes, \(furniture.count) non-messages, 1 unknown kind held back")
    exit(0)
}

if once {
    sampler.promptAccessibility()
    calendar.requestAccess()
    let s = sampler.sample()
    let p = currentPermissions()
    struct Out: Encodable { var sample: Sample; var permissions: Permissions }
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(data: try! encoder.encode(Out(sample: s, permissions: p)), encoding: .utf8)!)
    exit(p.accessibility && p.calendar ? 0 : 2)
}

guard let token = try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
    log("no token at \(tokenPath); run scripts/brain.sh setup")
    exit(1)
}
let client = Client(base: serverURL, token: token)

sampler.promptAccessibility()
calendar.requestAccess()

var buffer: [Data] = []
var exclusions = HeartbeatResponse.Exclusions(apps: [], domains: [])
var paused = false
var lastCalendar = Date.distantPast
var lastRetry = Date.distantPast
var lastHelperInfo = Date.distantPast
var lastPausedPing = Date.distantPast
var lastSlack = Date.distantPast
/// Set when macOS reports a calendar change; the next tick (at most 5 s later) reposts.
var calendarChanged = false

func excluded(_ s: Sample) -> Bool {
    if let id = s.appId, exclusions.apps.contains(id) { return true }
    guard let u = s.url, let host = URL(string: u)?.host?.lowercased() else { return false }
    let h = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    return exclusions.domains.contains { p in
        let p = p.lowercased()
        if p.hasPrefix("*.") { return h.hasSuffix(String(p.dropFirst(1))) }
        return h == p || h.hasSuffix("." + p)
    }
}

func flush() {
    while let first = buffer.first {
        guard let (status, body) = client.post("/api/activity/heartbeat", json: first) else { return }
        if status >= 500 {
            log("server error \(status), keeping \(buffer.count) heartbeat(s)")
            return
        }
        buffer.removeFirst()
        if status == 200, let r = try? JSONDecoder().decode(HeartbeatResponse.self, from: body) {
            exclusions = r.exclusions
            paused = r.paused
        } else if status == 401 {
            log("server rejected the token (401)")
        }
    }
}

func tick() {
    let now = Date()
    let s = sampler.sample(now: now)
    var hb = Heartbeat(at: s.at, idleSeconds: s.idleSeconds)
    if now.timeIntervalSince(lastHelperInfo) > 60 {
        hb.helper = HelperInfo(version: VERSION, permissions: currentPermissions())
        lastHelperInfo = now
    }
    if paused {
        // One light heartbeat a minute keeps "last seen" fresh and notices when recording resumes.
        if now.timeIntervalSince(lastPausedPing) < 60 { return }
        lastPausedPing = now
        hb.paused = true
    } else if s.idleSeconds >= AFK_SECONDS {
        hb.afk = true
    } else if excluded(s) {
        // Drop the sample locally; a placeholder app id lets the server close the previous session.
        hb.appId = EXCLUDED_APP_ID
        hb.appName = "Excluded"
    } else {
        hb.appId = s.appId
        hb.appName = s.appName
        hb.title = s.title
        hb.url = s.url
    }
    if let data = try? encoder.encode(hb) {
        buffer.append(data)
        if buffer.count > MAX_BUFFER { buffer.removeFirst(buffer.count - MAX_BUFFER) }
    }
    if buffer.count == 1 || now.timeIntervalSince(lastRetry) >= RETRY_INTERVAL {
        flush()
        if !buffer.isEmpty { lastRetry = now }
    }
    // Without calendar access there is nothing to say about the window: an empty payload
    // would tell the server every event in it had vanished, so nothing is posted at all.
    if calendar.granted, calendarChanged || now.timeIntervalSince(lastCalendar) >= CALENDAR_INTERVAL {
        calendarChanged = false
        lastCalendar = now
        let body = CalendarBody(events: calendar.upcoming(now: now), window: calendar.window(now: now), calendarsSeen: calendar.calendarsSeen)
        if let data = try? encoder.encode(body) { _ = client.post("/api/activity/calendar", json: data) }
    }
    // Slack reads nothing while capture is paused: one switch covers every source, and an adaptor
    // that kept reading through a pause would be the one thing the pause is meant to stop.
    if !paused, now.timeIntervalSince(lastSlack) >= SLACK_INTERVAL {
        lastSlack = now
        postSlack()
    }
}

/// Reads whatever Slack is showing and posts it. Unsent reads are not buffered the way heartbeats
/// are: an observation is a durable fact the server upserts on `(source, externalId)`, so the next
/// pass re-reads and re-posts the same rows at no cost, and a missed post loses nothing.
func postSlack() {
    guard let observations = slack.read(), !observations.isEmpty else { return }
    struct Body: Encodable { var observations: [Observation] }
    // The server caps a batch at 500. A rendered viewport is nowhere near that, so this only ever
    // guards against a surprise rather than paging through one.
    let body = Body(observations: Array(observations.prefix(500)))
    guard let data = try? encoder.encode(body),
          let (status, _) = client.post("/api/ingest/observations", json: data) else { return }
    if status == 401 { log("server rejected the token for observations (401)") }
    else if status >= 400 { log("observations rejected with \(status)") }
}

/// Held for the process's life so the calendar-change subscription stays alive.
let calendarObserver = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { _ in
    // The store hands back cached objects until it is reset, so the next fetch would miss the change.
    calendar.reset()
    calendarChanged = true
}

log("started, server \(serverURL), data \(dataDir)")
let timer = Timer(timeInterval: SAMPLE_INTERVAL, repeats: true) { _ in tick() }
RunLoop.main.add(timer, forMode: .common)
tick()
RunLoop.main.run()
