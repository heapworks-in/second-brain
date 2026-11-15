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

    private var asked = false

    /// Slack's message rows carry Slack's own `ts` as the tail of their DOM id, e.g.
    /// `message-list_1793915061.120209`. Matching the suffix rather than the `message-list_` prefix
    /// keeps this working in whichever view the row is drawn in, and separates real messages from
    /// the furniture sharing that prefix: date separators (`..._1793903400000.C0CLCR9BL`), the
    /// unread divider (`..._1794249000000divider`) and `message-list_bottomSpacer`. A separator read
    /// as a message would hand the desk "Friday, November 6th" as something a colleague is awaiting.
    private static let rowId = try! NSRegularExpression(pattern: #"_(\d{10,}\.\d{1,6})$"#)
    /// The permalink is the one hook carrying both ids: `/archives/<channel>/p<ts-without-dot>`.
    private static let permalink = try! NSRegularExpression(pattern: #"/archives/([A-Z0-9]+)/p?(\d+)"#)
    private static let nonSlug = try! NSRegularExpression(pattern: #"[^a-z0-9]+"#)
    private static let bracketed = try! NSRegularExpression(pattern: #"\s*\([^)]*\)"#)
    private static let whitespace = try! NSRegularExpression(pattern: #"\s+"#)

    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Which view Slack is showing (`activity-inbox`, `home`, `dms`, …), or nil if it cannot be
    /// read at all. The automatic path never needs this; the `--slack` diagnostic exists to answer
    /// "why is nothing arriving", and the answer is usually this.
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
    /// addressing you; a channel is full of messages that have nothing to do with you, and
    /// reporting those as asks you owe would be worse than reporting nothing. `requireActivity` is
    /// relaxed only by the diagnostic, which prints and posts nothing.
    func read(requireActivity: Bool = true) -> [Observation]? {
        guard AXIsProcessTrusted(), let app = Self.slackApp() else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)

        ask(axApp)

        guard let window = Self.window(axApp) else { return nil }
        if requireActivity && Self.selectedTab(window) != Self.activityTab { return nil }

        let names = Self.channelNames(window)
        var seen = Set<String>()
        var out: [Observation] = []
        for row in Self.rows(window) {
            guard let message = Self.read(row: row.element, ts: row.ts) else { continue }
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
                context: names[message.channel].map { $0.hasPrefix("#") ? $0 : "#\($0)" }))
        }
        return out
    }

    /// Chromium builds its accessibility tree only when something asks for it. Without this a walk
    /// finds a handful of empty AXGroups, which looks exactly like "Slack exposes nothing". It takes
    /// effect asynchronously, so the first read after asking may still come back empty; the next
    /// pass picks it up rather than blocking this one on a poll.
    private func ask(_ axApp: AXUIElement) {
        guard !asked else { return }
        asked = AXUIElementSetAttributeValue(
            axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
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

    /// Pre-order, because document ORDER is what tells the sender button from the hover toolbar:
    /// the sender comes before the timestamp link, the toolbar after.
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

    // MARK: - Reading

    /// The left-rail tabs carry a DOM id (`activity-inbox`, `home`, `dms`, …) and a selected flag.
    private static func selectedTab(_ window: AXUIElement) -> String? {
        var found: String?
        walk(window) { el, _ in
            guard found == nil,
                  let dom = string(el, "AXDOMIdentifier"),
                  string(el, kAXRoleAttribute as String) == "AXRadioButton",
                  string(el, kAXSelectedAttribute as String) == "1" else { return }
            found = dom
        }
        return found
    }

    /// `C0CL9G6CF` -> `general`, read off the sidebar rows, which carry the channel id as their DOM
    /// id. Only ever a nicety: a card without a channel name is still a card.
    private static func channelNames(_ window: AXUIElement) -> [String: String] {
        var names: [String: String] = [:]
        walk(window) { el, _ in
            guard let dom = string(el, "AXDOMIdentifier"),
                  dom.range(of: #"^[CDG][A-Z0-9]{6,}$"#, options: .regularExpression) != nil,
                  names[dom] == nil,
                  let title = string(el, kAXTitleAttribute as String) else { return }
            // Sidebar titles arrive decorated for a screen reader -- "general (channel), 3 unread".
            let stripped = bracketed.stringByReplacingMatches(
                in: title, range: NSRange(title.startIndex..., in: title), withTemplate: "")
            let name = (stripped.split(separator: ",").first.map(String.init) ?? stripped)
                .trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { names[dom] = name }
        }
        return names
    }

    private static func rows(_ window: AXUIElement) -> [(element: AXUIElement, ts: String)] {
        var found: [(AXUIElement, String)] = []
        walk(window) { el, _ in
            guard let dom = string(el, "AXDOMIdentifier"), let ts = timestamp(domId: dom) else { return }
            found.append((el, ts))
        }
        return found
    }

    /// Internal rather than private so the self-check can assert it: this is the one piece of
    /// parsing here that fails silently rather than loudly.
    static func timestamp(domId: String) -> String? {
        let range = NSRange(domId.startIndex..., in: domId)
        guard let m = rowId.firstMatch(in: domId, range: range), m.numberOfRanges > 1,
              let captured = Range(m.range(at: 1), in: domId) else { return nil }
        return String(domId[captured])
    }

    private struct Message {
        var ts: String
        var channel: String
        var sender: String?
        var text: String
        var url: String?
    }

    private static func read(row: AXUIElement, ts: String) -> Message? {
        // Flatten first: the sender button, the timestamp link and the body sit at varying depths,
        // and their order is the only thing that reliably distinguishes them.
        struct Node { var role: String; var depth: Int; var title: String?; var value: String?; var url: String? }
        var flat: [Node] = []
        walk(row, limit: 20) { el, depth in
            flat.append(Node(
                role: string(el, kAXRoleAttribute as String) ?? "?",
                depth: depth,
                title: string(el, kAXTitleAttribute as String),
                value: string(el, kAXValueAttribute as String),
                url: string(el, "AXURL")))
        }

        // The timestamp link splits the row: sender before it, message text after.
        var channel: String?
        var url: String?
        var splitAt: Int?
        for (i, node) in flat.enumerated() {
            guard node.role == "AXLink", let href = node.url else { continue }
            let range = NSRange(href.startIndex..., in: href)
            guard let m = permalink.firstMatch(in: href, range: range),
                  let captured = Range(m.range(at: 1), in: href) else { continue }
            channel = String(href[captured])
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

        let joined = flat[start...]
            .filter { $0.role == "AXStaticText" }
            .compactMap { $0.value }
            .joined(separator: " ")
        let text = whitespace
            .stringByReplacingMatches(in: joined, range: NSRange(joined.startIndex..., in: joined),
                                      withTemplate: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        return Message(ts: ts, channel: channel, sender: sender, text: String(text.prefix(4000)), url: url)
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
