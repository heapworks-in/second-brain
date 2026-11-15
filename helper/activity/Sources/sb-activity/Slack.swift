import AppKit
import ApplicationServices
import Foundation

// Reads the asks sitting in Slack's Activity view and reports them as observations. Reports only:
// whether something is an ask, how urgent it is and who it is owed to are all decided server-side.
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

    // MARK: - The two id schemes

    /// An Activity row: `at_channel-C0CLCR9BL-1794429455.856259` -- what kind of activity, then the
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
    /// `message-list_1793915061.120209`. The underscore is what separates a message from the
    /// furniture sharing the prefix -- date separators are `message-list_1793903400000.C0CLCR9BL`,
    /// plus `...divider` and `message-list_bottomSpacer`. A separator read as a message would hand
    /// the desk "Friday, November 6th" as something a colleague is waiting on.
    private static let channelRowId = try! NSRegularExpression(pattern: #"_(\d{10,}\.\d{1,6})$"#)

    /// A channel row's timestamp link carries both ids: `/archives/<channel>/p<ts-without-dot>`.
    private static let permalink = try! NSRegularExpression(pattern: #"/archives/([A-Z0-9]+)/p?(\d+)"#)
    /// `... mentioned you in #your-next-job: ...` -- the channel's NAME, which an Activity row has
    /// only in its label. The sidebar is not rendered in this view, so there is no id to resolve.
    private static let hashName = try! NSRegularExpression(pattern: #"#([^\s:]+)"#)
    /// `https://app.slack.com/client/T0CLCJ1AM/activity-inbox` -- needed to rebuild a permalink an
    /// Activity row does not carry.
    private static let teamId = try! NSRegularExpression(pattern: #"/client/(T[A-Z0-9]+)"#)
    private static let nonSlug = try! NSRegularExpression(pattern: #"[^a-z0-9]+"#)
    private static let whitespace = try! NSRegularExpression(pattern: #"\s+"#)

    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

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

    /// Everything Slack has currently drawn in its Activity view, or `nil` when there is nothing to
    /// read -- Slack not running, no window, or a view this must not read.
    ///
    /// It refuses any view but Activity on purpose. Every row in Activity is by definition somebody
    /// addressing you; a channel is full of messages that have nothing to do with you, and reporting
    /// those as asks you owe would be worse than reporting nothing. `requireActivity` is relaxed
    /// only by the diagnostic, which posts nothing.
    func read(requireActivity: Bool = true) -> [Observation]? {
        guard AXIsProcessTrusted(), let app = Self.slackApp() else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        ask(axApp)

        guard let window = Self.window(axApp) else { return nil }
        if requireActivity && Self.selectedTab(window) != Self.activityTab { return nil }

        let team = Self.team(window)
        var seen = Set<String>()
        var out: [Observation] = []

        for (element, row) in Self.rows(window) {
            let message: Message?
            switch row {
            case let .activity(_, channel, ts):
                message = Self.readActivityRow(element, channel: channel, ts: ts, team: team)
            case let .channel(ts):
                message = Self.readChannelRow(element, ts: ts)
            case let .unknown(kind):
                skipped.insert(kind)
                continue
            }
            guard let message else { continue }
            let externalId = "\(message.channel)/\(message.ts)"
            guard seen.insert(externalId).inserted, let seconds = Double(message.ts) else { continue }
            out.append(Observation(
                source: Self.source,
                externalId: externalId,
                // The message's own timestamp, never now. An ask read today that was made three
                // weeks ago has earned three weeks of urgency, and stamping the read time would
                // quietly reset a whole backlog of waiting people to zero.
                at: iso.string(from: Date(timeIntervalSince1970: seconds)),
                kind: message.channel.hasPrefix("D") ? "dm" : "mention",
                actorHandle: Self.handle(message.sender),
                actorName: message.sender,
                text: message.text,
                url: message.url,
                context: message.context))
        }
        return out
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

    private struct Message {
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
