"use client";

import { useEffect, useState } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
import { Button, SectionHeading } from "../ui";

interface Adaptors {
  extensionPath: string | null;
  token: string | null;
  helperPath: string | null;
}

interface ActivityStatus {
  helper?: { permissions?: { accessibility?: boolean } };
}

/**
 * How Slack gets read, on a machine with no terminal.
 *
 * Two routes, and the order matters. The Slack app needs nothing installed -- the activity helper
 * already runs and already reads windows through Accessibility, so the only step is a permission.
 * The Chrome extension is second because Chrome will not let any program add an extension: off-store
 * installs are gone on macOS and the only override is an enterprise policy profile, so "Developer
 * mode" and "Load unpacked" are steps a person has to take whatever we ship. On a managed Chrome
 * offering only "Pack extension" they cannot take them at all, which is why the first route exists.
 *
 * Accessibility is shown rather than assumed. It was off here while everything downstream of it was
 * built and shipped, and nothing said so.
 */
export function AdaptorsSection() {
  const [state, setState] = useState<Adaptors | null>(null);
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/adaptors")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Adaptors | null) => {
        if (!cancelled) setState(d);
      })
      .catch(() => {});
    fetch("/api/activity/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ActivityStatus | null) => {
        if (!cancelled) setAccessibility(d?.helper?.permissions?.accessibility ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy(what: string, value: string | null) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SectionHeading>Slack</SectionHeading>
        <p className="text-[13px] text-fg-muted max-w-prose">
          Your mentions come here, and the ones you never answered become cards on the desk, growing more urgent the
          longer somebody waits. It reads only — it never types, sends or reacts in Slack.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-[13px] font-medium text-fg">From the Slack app</h4>
          {accessibility === null ? null : accessibility ? (
            <span className="text-[11px] text-violet-bright">Accessibility granted</span>
          ) : (
            <span className="text-[11px] text-fg-faint">needs Accessibility</span>
          )}
        </div>
        {accessibility === false ? (
          <ol className="flex flex-col gap-2 text-[13px] text-fg-muted list-decimal pl-5 max-w-prose">
            <li>
              Open <strong className="text-fg font-medium">System Settings › Privacy &amp; Security › Accessibility</strong>{" "}
              and add this file:
              {state?.helperPath ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 truncate font-mono text-[11.5px] bg-layer-1 border border-hairline rounded px-2 py-1">
                    {state.helperPath}
                  </code>
                  <Button size="sm" variant="ghost" onClick={() => void copy("path", state.helperPath)}>
                    {copied === "path" ? <Check className="w-3.5 h-3.5 text-violet-bright" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
                    {copied === "path" ? "Copied" : "Copy path"}
                  </Button>
                </div>
              ) : null}
              <span className="block mt-1 text-fg-faint">
                If an entry for it is already listed, remove it and add it again — macOS pins the grant to one exact
                build, so an update voids it while the switch carries on looking on.
              </span>
            </li>
            <li>
              In Slack, open <strong className="text-fg font-medium">Activity</strong>. Whatever is showing there is
              picked up within the minute.
            </li>
          </ol>
        ) : (
          <p className="text-[13px] text-fg-muted max-w-prose">
            Nothing to install. Open <strong className="text-fg font-medium">Activity</strong> in Slack and what is
            showing there is picked up within the minute. Only Activity is read — a channel is full of messages that
            have nothing to do with you.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-[13px] font-medium text-fg">Or from Chrome</h4>
        <p className="text-[13px] text-fg-muted max-w-prose">For a machine where you use Slack in a browser.</p>
        {state?.extensionPath ? (
          <ol className="flex flex-col gap-2 text-[13px] text-fg-muted list-decimal pl-5 max-w-prose">
            <li>
              Open <span className="font-mono text-[12px] text-fg">chrome://extensions</span> and turn on{" "}
              <strong className="text-fg font-medium">Developer mode</strong>.
            </li>
            <li>
              Click <strong className="text-fg font-medium">Load unpacked</strong> and choose this folder:
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 truncate font-mono text-[11.5px] bg-layer-1 border border-hairline rounded px-2 py-1">
                  {state.extensionPath}
                </code>
                <Button size="sm" variant="ghost" onClick={() => void fetch("/api/settings/adaptors", { method: "POST" })}>
                  <FolderOpen className="w-3.5 h-3.5" aria-hidden />
                  Show
                </Button>
              </div>
            </li>
            <li>
              Open the extension&rsquo;s Options and paste the token:
              <div className="mt-1.5">
                <Button size="sm" variant="ghost" onClick={() => void copy("token", state.token)} disabled={!state.token}>
                  {copied === "token" ? <Check className="w-3.5 h-3.5 text-violet-bright" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
                  {copied === "token" ? "Copied" : "Copy token"}
                </Button>
              </div>
            </li>
            <li>
              In Slack, open <strong className="text-fg font-medium">Activity</strong>, click the extension, then{" "}
              <strong className="text-fg font-medium">Read Activity</strong>.
            </li>
          </ol>
        ) : (
          <p className="text-[13px] text-fg-faint max-w-prose">
            This install has no bundled copy — it ships with the desktop app. In a source checkout the extension is in
            the <span className="font-mono text-[12px]">sb-adaptors</span> repo, under{" "}
            <span className="font-mono text-[12px]">slack/extension</span>.
          </p>
        )}
      </div>
    </div>
  );
}
