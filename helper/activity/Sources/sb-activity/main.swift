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
    // The names to treat as mine. The helper proper is handed these by the server; a diagnostic has
    // no heartbeat to be handed anything by, and taking them on the command line is better than a
    // second way to configure them -- a spelling can be tried here before it is saved anywhere.
    var mine: Set<String> = []
    if let i = args.firstIndex(of: "--me"), i + 1 < args.count {
        mine = Set(args[i + 1].split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty })
    }
    guard let view = slack.openView() else {
        print("cannot read Slack: it is not running, has no window, or Accessibility is not granted")
        exit(1)
    }
    print("Slack is showing: \(view)")
    if mine.isEmpty {
        print("""
        No names to match, so nothing is treated as yours and no questions of yours can be read --
        only the Activity view's asks. Pass --me "Your Slack Name" to try a spelling. The helper
        gets this list from the server: Settings, the spellings of your own name, the same list a
        tracker import matches an Owner column against.
        """)
    }
    let observations = slack.read(mine: mine) ?? []
    print("\(observations.count) message(s) readable (Slack renders a viewport, not a feed)")
    for o in observations.prefix(10) {
        let who = o.kind == "sent" ? "you asked" : (o.actorName ?? "?")
        let answered = o.meta?["answeredAt"] != nil ? " [answered]" : ""
        print("  \(o.at)  \(who)\(answered)  \(o.context ?? o.externalId)  \(o.text.prefix(60))")
    }
    // The names Slack is putting on these rows, which is the only way to see that the list of my
    // own spellings does not contain the one it uses. That mismatch is silent otherwise: the reader
    // works perfectly and reports nothing, forever.
    if !slack.sendersSeen.isEmpty {
        let names = slack.sendersSeen.sorted()
        print("names on the messages here: \(names.joined(separator: ", "))")
        if !names.contains(where: { mine.contains($0.lowercased()) }) {
            print("none of those match \(mine.isEmpty ? "anything (no names given)" : mine.sorted().joined(separator: ", "))"
                + " -- whichever is you belongs in Settings, spelled exactly as it reads above")
        }
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
    // The other half: which rows in a conversation are mine, which of mine are still hanging, and
    // whose words an unnamed row belongs to. All three fail silently, and the last one fails in the
    // expensive direction -- somebody else's ask filed as a question of mine disappears from the
    // part of the desk that owes them a reply.
    typealias M = SlackReader.Message
    let me: Set<String> = ["avinash", "avinash vundyala"]
    let conversation = SlackReader.carrySenders([
        M(ts: "1794429455.100000", channel: "C1", sender: "Avinash Vundyala", text: "did the deploy go out?", url: nil, context: nil),
        // Slack omits the sender on a run, so this one is mine too -- and it supersedes the above.
        M(ts: "1794429460.100000", channel: "C1", sender: nil, text: "or is it still queued?", url: nil, context: nil),
        M(ts: "1794429470.100000", channel: "C1", sender: "Avinash Vundyala", text: "thanks, all clear", url: nil, context: nil),
        // A different conversation: an unnamed row here must NOT inherit my name.
        M(ts: "1794429480.100000", channel: "C2", sender: nil, text: "can you confirm the Q4 numbers?", url: nil, context: nil),
        M(ts: "1794429490.100000", channel: "C3", sender: "Avinash", text: "any update on the creds?", url: nil, context: nil),
        M(ts: "1794429495.100000", channel: "C4", sender: "Priya Raman", text: "are we still on for Friday?", url: nil, context: nil),
    ])
    guard conversation[1].sender == "Avinash Vundyala", conversation[3].sender == nil else {
        log("FAIL: the sender carried across a conversation boundary"); exit(1)
    }
    let questions = SlackReader.ownQuestions(conversation, mine: me)
    // "thanks, all clear" asked nothing, and C2's unnamed row and C4's Priya are not mine.
    let asked = questions.map { "\($0.0.channel)/\($0.0.ts)" }.sorted()
    guard asked == ["C1/1794429455.100000", "C1/1794429460.100000", "C3/1794429490.100000"] else {
        log("FAIL: my own questions read as \(asked)"); exit(1)
    }
    // Only the newest message in a conversation can be left hanging. Both of C1's questions have
    // something after them -- the second one my own "thanks, all clear", which is me saying I
    // stopped waiting -- so C3's, the last thing said there, is the only one owed an answer.
    let hanging = questions.filter { $0.1 == nil }.map { "\($0.0.channel)/\($0.0.ts)" }
    guard hanging == ["C3/1794429490.100000"] else {
        log("FAIL: still hanging read as \(hanging), wanted [C3/1794429490.100000]"); exit(1)
    }
    guard SlackReader.ownQuestions(conversation, mine: []).isEmpty else {
        log("FAIL: with no name to match, something was still claimed as mine"); exit(1)
    }
    print("slack self-check ok: \(expected.count) rows across 2 schemes, \(furniture.count) non-messages, 1 unknown kind held back, \(asked.count) of \(conversation.count) conversation rows mine, \(hanging.count) still hanging")
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
/// The spellings of my own name, lowercased, as the server knows them. Empty until the first
/// heartbeat comes back, which is the right default: nothing is claimed as mine on a guess.
var identities: Set<String> = []
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
            identities = Set((r.identities ?? []).map { $0.lowercased() })
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
    guard let observations = slack.read(mine: identities), !observations.isEmpty else { return }
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
