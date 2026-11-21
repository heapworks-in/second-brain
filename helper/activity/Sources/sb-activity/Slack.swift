import AppKit
import ApplicationServices
import Foundation

// Reads the asks sitting in Slack's Activity view, and the questions you asked that nobody
// answered, and reports both as observations. Reports only: whether something is an ask, how
// urgent it is and who it is owed to are all decided server-side.
//
// This lives in the activity helper rather than in its own binary for one reason: Accessibility is
// granted per executable, and an ad-hoc signed one loses the grant on every rebuild (see
// accessibility_advice in scripts/brain.sh). A second binary would mean a second grant to add by
// hand, and to re-add after each update. This helper is already granted and already supervised.

struct Observation: Encodable {
    var source: String
    var externalId: String
    var at: String
    var kind: String
    var actorHandle: String?
    var actorName: String?
    var text: String
    var url: String?
    var context: String?
    /// Free-form. Carries nothing today: whether anybody has replied used to be reported here, per
    /// message, and is now derived server-side from the conversation report below -- which is both
    /// less to send and a better answer, because a report is only ever about what was on screen.
    var meta: [String: String]?
}

/// What a pass could see of a conversation's tail, and the only thing reported about the messages
/// in it that are not mine.
///
/// Two timestamps, not a transcript. `mineAt` is the last time I said anything here and `theirsAt`
/// the last time anybody else did, and between them the server can answer every "is this still
/// waiting?" without a single word of somebody else's message ever leaving Slack. A reader that
/// parses a whole channel to report two numbers is reporting strictly less than one that reports
/// the messages -- and the old per-message `answeredAt` it replaces was the weaker fact anyway:
/// "something came after mine", true of whatever happened to be drawn and nothing more.
struct ConversationReport: Encodable {
    var source: String
    var externalId: String
    var name: String?
    var mineAt: String?
    var theirsAt: String?
}

/// One pass: the messages worth keeping, and what was visible of the places they were said.
struct Reading: Encodable {
    var observations: [Observation]
    var conversations: [ConversationReport]
}

/// Reads Slack through Accessibility. Holds one piece of state -- whether Chromium has been asked
/// to publish its tree -- so the steady-state read is a plain walk and not a ten-second poll.
final class SlackReader {
    static let activityTab = "activity-inbox"
    private static let source = "slack"

    /// The left rail's own tabs. The view guard matches against this set rather than taking the
    /// first selected radio button it finds: a channel's sub-tabs carry DOM ids too (`channel`,
    /// `files`, `bookmarks`), so "whichever radio button is selected" could answer `channel` and let
    /// a whole channel be read as though it were the Activity view. Note `files` is a channel
    /// sub-tab while the rail's is `unified-files` -- close enough to be worth naming explicitly.
    private static let railTabs: Set<String> = [
        "home", "dms", "activity-inbox", "unified-files", "later", "platform",
    ]

    private var asked = false
    /// Row kinds seen but not imported, surfaced by the diagnostic. Learning what else Slack puts
    /// in this view beats either dropping it silently or importing it on a guess.
    private(set) var skipped: Set<String> = []
    /// Every name seen on a message in a conversation, for the diagnostic. The one thing that fails
    /// without a symptom here is the list of my own spellings not containing the one Slack prints,
    /// and the only way to tell is to see the names Slack is actually putting on these rows.
    private(set) var sendersSeen: Set<String> = []

    // MARK: - The two id schemes

    /// An Activity row: `at_channel-C0A1B2C3D-1794429455.100200` -- what kind of activity, then the
    /// channel, then Slack's own `ts`. Both ids come straight out of this, which matters because an
    /// Activity row carries no permalink to read them off instead.
    ///
    /// The kind is not pinned to `at_channel`: a DM mention and a thread reply are the same shape
    /// with a different word in front. `at_` IS pinned, because a mention is the only kind present
    /// in a real workspace to check against -- anything else goes to `skipped`. A reaction is not an
    /// ask, and importing one as a card somebody is waiting on would be worse than missing it.
    private static let activityRowId = try! NSRegularExpression(
        pattern: #"^(at_[a-z_]+)-([CDG][A-Z0-9]{6,})-(\d{10,}\.\d{1,6})$"#)
    /// The same shape without the `at_` -- an unknown kind, reported rather than read.
    private static let otherRowId = try! NSRegularExpression(
        pattern: #"^([a-z_]+)-([CDG][A-Z0-9]{6,})-(\d{10,}\.\d{1,6})$"#)
    /// A channel row, which only the diagnostic's --any-view reaches:
    /// `message-list_1793915061.100300`. The underscore is what separates a message from the
    /// furniture sharing the prefix -- date separators are `message-list_1793903400000.C0A1B2C3D`,
    /// plus `...divider` and `message-list_bottomSpacer`. A separator read as a message would hand
    /// the desk "Friday, November 6th" as something a colleague is waiting on.
    private static let channelRowId = try! NSRegularExpression(pattern: #"_(\d{10,}\.\d{1,6})$"#)

    /// A channel row's timestamp link carries both ids: `/archives/<channel>/p<ts-without-dot>`.
    private static let permalink = try! NSRegularExpression(pattern: #"/archives/([A-Z0-9]+)/p?(\d+)"#)
    /// `... mentioned you in #project-atlas: ...` -- the channel's NAME, which an Activity row has
    /// only in its label. The sidebar is not rendered in this view, so there is no id to resolve.
    private static let hashName = try! NSRegularExpression(pattern: #"#([^\s:]+)"#)
    /// `https://app.slack.com/client/T0H7I8J9K/activity-inbox` -- needed to rebuild a permalink an
    /// Activity row does not carry.
    private static let teamId = try! NSRegularExpression(pattern: #"/client/(T[A-Z0-9]+)"#)
    /// `your-next-job (Channel) - Acme - Slack` -- the name, then what kind of thing it is.
    private static let windowTitle = try! NSRegularExpression(pattern: #"^(.+?) \(([^)]+)\)"#)
    private static let nonSlug = try! NSRegularExpression(pattern: #"[^a-z0-9]+"#)
    private static let whitespace = try! NSRegularExpression(pattern: #"\s+"#)

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func isoString(from seconds: Double) -> String {
        iso.string(from: Date(timeIntervalSince1970: seconds))
    }

    // MARK: - Public surface

    /// Which view Slack is showing (`activity-inbox`, `home`, `dms`, …), or nil if it cannot be read
    /// at all. The automatic path never needs this; the `--slack` diagnostic exists to answer "why
    /// is nothing arriving", and the answer is usually this.
    func openView() -> String? {
        guard AXIsProcessTrusted(), let app = Self.slackApp() else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        ask(axApp)
        guard let window = Self.window(axApp) else { return nil }
        return Self.selectedTab(window)
    }

    /// Everything worth reporting out of whatever Slack has currently drawn, or `nil` when there is
    /// nothing to read at all -- Slack not running, no window, Accessibility not granted.
    ///
    /// Two directions, decided per row rather than per view:
    ///
    /// An **Activity** row is by definition somebody addressing you, so all of them are reported.
    ///
    /// A **channel or DM** row is reported only when it is one of yours *and* it asked something.
    /// That rule is what used to be a blanket refusal to read any view but Activity, and it is the
    /// same protection stated per row instead of per view: a channel is full of messages that have
    /// nothing to do with you, and reporting those as asks you owe would be worse than reporting
    /// nothing. Phrased this way it also stops being a reason to miss the other half of a backlog --
    /// the questions you asked, which nobody will ever remind you went unanswered.
    ///
    /// `mine` is the spellings of your own name, handed down by the server (`identity.names`, the
    /// same list a tracker import matches an Owner column against). Empty means nothing is claimed
    /// as yours: without it, somebody else's message filed as one of mine would vanish from the
    /// half of the desk that owes them a reply, which is worse than this feature not working.
    func read(mine: Set<String> = []) -> Reading? {
        guard AXIsProcessTrusted(), let app = Self.slackApp() else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        ask(axApp)

        guard let window = Self.window(axApp) else { return nil }
        let team = Self.team(window)

        var inbound: [Message] = []
        var conversation: [Message] = []

        for (element, row) in Self.rows(window) {
            switch row {
            case let .activity(_, channel, ts):
                if let message = Self.readActivityRow(element, channel: channel, ts: ts, team: team) {
                    inbound.append(message)
                }
            case let .channel(ts):
                guard let message = Self.readChannelRow(element, ts: ts) else { continue }
                if let sender = message.sender { sendersSeen.insert(sender) }
                conversation.append(message)
            case let .unknown(kind):
                skipped.insert(kind)
            }
        }
        conversation = Self.carrySenders(conversation)

        var out: [Observation] = []
        var seen = Set<String>()
        for message in inbound {
            let kind = message.channel.hasPrefix("D") ? "dm" : "mention"
            if let o = observation(message, kind: kind), seen.insert(o.externalId).inserted { out.append(o) }
        }
        // A channel row carries no label naming its own channel -- the whole view is that channel,
        // so the name is in the window title instead.
        let here = Self.viewName(window)
        for message in Self.ownQuestions(conversation, mine: mine) {
            var message = message
            if message.context == nil { message.context = here }
            guard let o = observation(message, kind: "sent"), seen.insert(o.externalId).inserted else { continue }
            out.append(o)
        }
        // Reported whether or not anything in this view was worth keeping. A channel full of other
        // people talking produces no observations at all and still moves `theirsAt` forwards, which
        // is exactly what expires the card for a question of mine they have finally got round to.
        return Reading(observations: out, conversations: Self.tails(conversation, mine: mine, name: here))
    }

    /// Slack prints the sender once for a run of messages from one person, so a row with no name
    /// belongs to whoever spoke last -- but only inside the same conversation. Resetting on the
    /// channel is what stops a sender that could not be read from handing one person's words to
    /// another, which in this direction would file their ask as a question of mine and lose it from
    /// the half of the desk that owes them a reply.
    ///
    /// Internal rather than private so the self-check can assert it: it fails silently.
    static func carrySenders(_ rows: [Message]) -> [Message] {
        var out: [Message] = []
        var lastSender: String?
        var lastChannel: String?
        for var row in rows {
            if row.channel != lastChannel { lastSender = nil }
            lastChannel = row.channel
            if let sender = row.sender { lastSender = sender } else { row.sender = lastSender }
            out.append(row)
        }
        return out
    }

    /// Which of these are mine and still asking something.
    ///
    /// It no longer works out whether anything came after each one. That question is now answered
    /// from the conversation's two timestamps, server-side, and the answer is strictly better:
    /// a question of mine is hanging when it is the last thing *anybody* said here, which is what
    /// `mineAt` and `theirsAt` together say. The old rule had to be re-derived from whatever was
    /// on screen on every pass, so a scroll could make a reply un-arrive.
    ///
    /// The rules it encoded are unchanged and now fall out of those two numbers: three questions
    /// in a row leave only the last (`mineAt` is the third), and a question I followed with
    /// "thanks, all clear" is one I plainly stopped waiting on (`mineAt` is the thanks).
    static func ownQuestions(_ rows: [Message], mine: Set<String>) -> [Message] {
        if mine.isEmpty { return [] }
        return rows.filter { row in
            guard let sender = row.sender, mine.contains(sender.lowercased()) else { return false }
            // Of my own messages, only the ones that asked for something. Everything else I type is
            // conversation, and a card a day after every "thanks" would bury the questions that are
            // genuinely hanging -- so the rest is not reported, and nothing keeps a copy of
            // everything I say in Slack. It misses "send me the creds when you can", which is the
            // honest trade for that; a model reads what does arrive and can still say it is not
            // really an ask, but nothing downstream can recover a message never reported.
            return row.text.contains("?")
        }
    }

    /// The tails of every conversation these rows came from.
    ///
    /// A row whose sender could not be read at all is counted as nobody's: attributing it would
    /// mean guessing, and guessing wrong in the `mineAt` direction silently answers a question
    /// nobody answered. `name` is only attached when the pass was looking at a single
    /// conversation, because the window title names the view and not each row in it.
    static func tails(_ rows: [Message], mine: Set<String>, name: String?) -> [ConversationReport] {
        var byChannel: [String: (mine: Double?, theirs: Double?)] = [:]
        for row in rows {
            // Skipped before the conversation is created, not after: a view whose every sender was
            // unreadable is a view nothing is known about, and reporting it would open a
            // conversation whose two timestamps say nothing. Better no row than an empty one.
            guard let seconds = Double(row.ts), let sender = row.sender?.lowercased() else { continue }
            var tail = byChannel[row.channel] ?? (nil, nil)
            if mine.contains(sender) {
                tail.mine = max(tail.mine ?? seconds, seconds)
            } else {
                tail.theirs = max(tail.theirs ?? seconds, seconds)
            }
            byChannel[row.channel] = tail
        }
        let single = byChannel.count == 1 ? name : nil
        return byChannel.map { channel, tail in
            ConversationReport(
                source: source,
                externalId: channel,
                name: single,
                mineAt: tail.mine.map { isoString(from: $0) },
                theirsAt: tail.theirs.map { isoString(from: $0) })
        }
    }

    private func observation(_ message: Message, kind: String) -> Observation? {
        guard let seconds = Double(message.ts) else { return nil }
        return Observation(
            source: Self.source,
            externalId: "\(message.channel)/\(message.ts)",
            // The message's own timestamp, never now. An ask read today that was made three
            // weeks ago has earned three weeks of urgency, and stamping the read time would
            // quietly reset a whole backlog of waiting people to zero.
            at: Self.isoString(from: seconds),
            kind: kind,
            actorHandle: Self.handle(message.sender),
            actorName: message.sender,
            text: message.text,
            url: message.url,
            context: message.context,
            meta: nil)
    }

    // MARK: - Attribute plumbing

    private static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    private static func string(_ el: AXUIElement, _ name: String) -> String? {
        guard let v = attr(el, name) else { return nil }
        if let s = v as? String { return s.isEmpty ? nil : s }
        if let u = v as? NSURL { return u.absoluteString }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    private static func children(_ el: AXUIElement) -> [AXUIElement] {
        attr(el, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
    }

    /// Pre-order, and the depth is load-bearing: in an Activity row the message text sits one level
    /// deeper than the sender and the footer, which is the only locale-independent way to tell them
    /// apart. In a channel row document ORDER is what separates the sender button from the hover
    /// toolbar.
    private static func walk(_ el: AXUIElement, depth: Int = 0, limit: Int = 40,
                             _ visit: (AXUIElement, Int) -> Void) {
        if depth > limit { return }
        visit(el, depth)
        for child in children(el) { walk(child, depth: depth + 1, limit: limit, visit) }
    }

    private static func slackApp() -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "com.tinyspeck.slackmacgap" }
    }

    /// Slack's *own* focused window, which is per-application and so still answers while Slack sits
    /// in the background -- which is where it sits whenever this helper runs.
    private static func window(_ axApp: AXUIElement) -> AXUIElement? {
        if let w = attr(axApp, kAXFocusedWindowAttribute as String) { return (w as! AXUIElement) }
        return (attr(axApp, kAXWindowsAttribute as String) as? [AXUIElement])?.first
    }

    private func ask(_ axApp: AXUIElement) {
        guard !asked else { return }
        // Chromium builds its accessibility tree only when something asks for it. Without this a
        // walk finds a handful of empty AXGroups, which looks exactly like "Slack exposes nothing".
        // It takes effect asynchronously, so the first read after asking may come back empty; the
        // next pass picks it up rather than blocking this one on a poll.
        asked = AXUIElementSetAttributeValue(
            axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
    }

    // MARK: - Finding rows

    private static func selectedTab(_ window: AXUIElement) -> String? {
        var found: String?
        walk(window) { el, _ in
            guard found == nil,
                  let dom = string(el, "AXDOMIdentifier"),
                  railTabs.contains(dom),
                  string(el, kAXRoleAttribute as String) == "AXRadioButton",
                  string(el, kAXSelectedAttribute as String) == "1" else { return }
            found = dom
        }
        return found
    }

    /// The workspace id, off the web area's own URL, so a permalink can be rebuilt for a row that
    /// has none.
    private static func team(_ window: AXUIElement) -> String? {
        var team: String?
        walk(window) { el, _ in
            guard team == nil,
                  string(el, kAXRoleAttribute as String) == "AXWebArea",
                  let url = string(el, "AXURL"),
                  let m = teamId.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
                  let r = Range(m.range(at: 1), in: url) else { return }
            team = String(url[r])
        }
        return team
    }

    /// Where Slack says I am, from its window title: `your-next-job (Channel) - Acme - Slack`, or a
    /// person's name for a DM. Read against a real workspace, which is how the hash came to be added
    /// here rather than expected in the title -- Slack does not put one there.
    private static func viewName(_ window: AXUIElement) -> String? {
        guard let title = string(window, kAXTitleAttribute as String) else { return nil }
        if let name = capture(hashName, title, 1) { return "#\(name)" }
        guard let name = capture(windowTitle, title, 1), let kind = capture(windowTitle, title, 2) else { return nil }
        // A channel gets its hash back; a DM is a person and reads better without one.
        return kind.lowercased().contains("channel") ? "#\(name)" : name
    }

    private enum Row {
        case activity(kind: String, channel: String, ts: String)
        case channel(ts: String)
        case unknown(kind: String)
    }

    private static func capture(_ re: NSRegularExpression, _ s: String, _ i: Int) -> String? {
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              m.numberOfRanges > i, let r = Range(m.range(at: i), in: s) else { return nil }
        return String(s[r])
    }

    private static func classify(domId: String) -> Row? {
        if let kind = capture(activityRowId, domId, 1),
           let channel = capture(activityRowId, domId, 2),
           let ts = capture(activityRowId, domId, 3) {
            return .activity(kind: kind, channel: channel, ts: ts)
        }
        if let kind = capture(otherRowId, domId, 1) { return .unknown(kind: kind) }
        if domId.hasPrefix("message-list_"), let ts = capture(channelRowId, domId, 1) {
            return .channel(ts: ts)
        }
        return nil
    }

    /// Internal rather than private so the self-check can assert it: this is the parsing that fails
    /// silently rather than loudly.
    static func timestamp(domId: String) -> String? {
        switch classify(domId: domId) {
        case let .activity(_, _, ts): return ts
        case let .channel(ts): return ts
        default: return nil
        }
    }

    /// Internal for the self-check: which scheme a row id matched, as a word.
    static func scheme(domId: String) -> String? {
        switch classify(domId: domId) {
        case .activity: return "activity"
        case .channel: return "channel"
        case let .unknown(kind): return "unknown:\(kind)"
        case nil: return nil
        }
    }

    private static func rows(_ window: AXUIElement) -> [(AXUIElement, Row)] {
        var found: [(AXUIElement, Row)] = []
        walk(window) { el, _ in
            guard let dom = string(el, "AXDOMIdentifier"), let row = classify(domId: dom) else { return }
            found.append((el, row))
        }
        return found
    }

    // MARK: - Reading a row

    struct Message {
        var ts: String
        var channel: String
        var sender: String?
        var text: String
        var url: String?
        var context: String?
    }

    private struct Node { var role: String; var depth: Int; var title: String?; var value: String?; var url: String? }

    private static func flatten(_ row: AXUIElement) -> [Node] {
        var flat: [Node] = []
        walk(row, limit: 20) { el, depth in
            flat.append(Node(
                role: string(el, kAXRoleAttribute as String) ?? "?",
                depth: depth,
                title: string(el, kAXTitleAttribute as String),
                value: string(el, kAXValueAttribute as String),
                url: string(el, "AXURL")))
        }
        return flat
    }

    private static func tidy(_ parts: [String]) -> String {
        let joined = parts.joined(separator: " ")
        return whitespace
            .stringByReplacingMatches(in: joined, range: NSRange(joined.startIndex..., in: joined),
                                      withTemplate: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// An Activity row has no sender button and no timestamp link. What it has is a flat run of
    /// labels -- sender, a day name, then the message, then a "Mention in #channel" footer -- and
    /// the message is the only part nested a level deeper than the rest. Depth is therefore the
    /// discriminator, and unlike matching on the word "Mention" it does not assume English.
    private static func readActivityRow(_ row: AXUIElement, channel: String, ts: String,
                                        team: String?) -> Message? {
        let flat = flatten(row)
        let texts = flat.enumerated().filter { $0.element.role == "AXStaticText" }
        guard let first = texts.first(where: { ($0.element.value ?? "").trimmingCharacters(in: .whitespaces).count > 0 })
        else { return nil }
        let metaDepth = first.element.depth

        let body = texts
            .filter { $0.offset > first.offset && $0.element.depth > metaDepth }
            .compactMap { $0.element.value }
        var text = tidy(body)

        let title = string(row, kAXTitleAttribute as String)
        if text.isEmpty {
            // No nested run -- fall back to Slack's own label, which reads
            // "<sender> mentioned you in #<channel>: <message>". Better a card with the right words
            // in it than a message quietly dropped for having no formatting.
            if let title, let colon = title.range(of: ": ") {
                text = tidy([String(title[colon.upperBound...])])
            }
        }
        guard !text.isEmpty else { return nil }

        return Message(
            ts: ts,
            channel: channel,
            sender: first.element.value,
            text: String(text.prefix(4000)),
            // Rebuilt rather than read: an Activity row has no link. Slack's client URLs take the
            // ts with its dot removed.
            url: team.map { "https://app.slack.com/client/\($0)/\(channel)/p\(ts.replacingOccurrences(of: ".", with: ""))" },
            context: title.flatMap { capture(hashName, $0, 1) }.map { "#\($0)" })
    }

    /// A channel row, reachable only through the diagnostic's --any-view. Here the timestamp link
    /// splits the row: the sender button comes before it, the message after.
    private static func readChannelRow(_ row: AXUIElement, ts: String) -> Message? {
        let flat = flatten(row)

        var channel: String?
        var url: String?
        var splitAt: Int?
        for (i, node) in flat.enumerated() {
            guard node.role == "AXLink", let href = node.url,
                  let found = capture(permalink, href, 1) else { continue }
            channel = found
            url = href
            splitAt = i
            break
        }
        guard let channel, let splitAt else { return nil }

        let sender = flat[..<splitAt].first { $0.role == "AXButton" && $0.title != nil }?.title

        // Everything after the link is the message -- except the link's own subtree, which holds the
        // time as Slack displays it ("3:14 AM"). Pre-order puts descendants immediately after their
        // parent, so skip forward while the depth is still below the link's.
        var start = splitAt + 1
        while start < flat.count && flat[start].depth > flat[splitAt].depth { start += 1 }

        let text = tidy(flat[start...].filter { $0.role == "AXStaticText" }.compactMap { $0.value })
        guard !text.isEmpty else { return nil }

        return Message(ts: ts, channel: channel, sender: sender, text: String(text.prefix(4000)),
                       url: url, context: nil)
    }

    /// Slack says `priya` where a meeting transcript says "Priya Raman". The server's
    /// `findOrCreateActor` matches on name first and falls back to this slug, so it has to be
    /// derived the same way the Chrome adaptor derives it or one person lands twice.
    private static func handle(_ name: String?) -> String? {
        guard let name else { return nil }
        let lower = name.lowercased()
        let slug = nonSlug
            .stringByReplacingMatches(in: lower, range: NSRange(lower.startIndex..., in: lower),
                                      withTemplate: "-")
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return slug.isEmpty ? nil : slug
    }
}

extension ISO8601DateFormatter {
    /// Seconds since the epoch from an ISO string with fractional seconds -- the inverse of what
    /// the reader emits, for the self-check. A plain string comparison there would be asserting a
    /// timezone rather than the rule.
    static func parse(_ s: String) -> Double? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)?.timeIntervalSince1970
    }
}
