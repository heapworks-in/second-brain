"use client";

import { useEffect, useState } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
import { Button, SectionHeading } from "../ui";

interface Adaptors {
  extensionPath: string | null;
  token: string | null;
}

/**
 * How the Slack reader gets installed, on a machine with no terminal.
 *
 * Chrome will not let any program add an extension -- off-store installs are gone on macOS and
 * the only override is an enterprise policy profile -- so "Developer mode" and "Load unpacked"
 * are steps a person has to take, whatever we ship. What this removes is everything around
 * them: the folder arrives with the app, this says where it is and opens it, and the token is a
 * button rather than a `cat` of a path with a space in it.
 */
export function AdaptorsSection() {
  const [state, setState] = useState<Adaptors | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/adaptors")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Adaptors | null) => {
        if (!cancelled) setState(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy() {
    if (!state?.token) return;
    try {
      await navigator.clipboard.writeText(state.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionHeading>Slack</SectionHeading>
      <p className="text-[13px] text-fg-muted max-w-prose">
        A Chrome extension reads your mentions and sends them here, where unanswered ones become cards on the desk. It
        reads only — it never types, sends or reacts in Slack.
      </p>
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
              <Button size="sm" variant="ghost" onClick={() => void copy()} disabled={!state.token}>
                {copied ? <Check className="w-3.5 h-3.5 text-violet-bright" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
                {copied ? "Copied" : "Copy token"}
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
          This install has no bundled copy — it ships with the desktop app. In a source checkout the extension is in the{" "}
          <span className="font-mono text-[12px]">sb-adaptors</span> repo, under{" "}
          <span className="font-mono text-[12px]">slack/extension</span>.
        </p>
      )}
    </div>
  );
}
