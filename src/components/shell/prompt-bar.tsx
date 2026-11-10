"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUp, FileText, Link2, Search, Square } from "lucide-react";
import { formatMinutes } from "@/lib/capacity";
import { detectIntent, type Intent } from "@/lib/intent";
import { useCapture } from "@/lib/use-capture";
import { useCurrentContainer } from "@/lib/current-container";
import { usePlanDate } from "@/lib/plan-date";
import { todayLocal } from "../activity/format";
import type { TaskDTO } from "@/lib/dto";
import { Kbd } from "../ui";
import { useToast } from "./toasts";
import { PromptMenu, PROMPT_ENTRIES, type PromptEntry } from "./prompt-menu";

const LABEL = "Ask, capture, or add a task";
const JSON_HEADERS = { "content-type": "application/json" };
const MAX_ROWS = 5;
const NARROW = "(max-width: 899px)";
const FIELD = "focus-ring flex-1 min-w-0 bg-transparent rounded-sm px-1 text-[14px] outline-none placeholder:text-fg-faint";

const MODE: Record<Intent["kind"], { label: string; icon: typeof FileText }> = {
  note: { label: "Note", icon: FileText },
  link: { label: "Link", icon: Link2 },
  task: { label: "Task", icon: Square },
  search: { label: "Search", icon: Search },
};

/** The menu's entries while `value` is still a bare `/word` being typed: `/t` leaves Task. */
function matchingEntries(value: string): PromptEntry[] {
  const typed = /^\/(\w*)$/.exec(value);
  if (!typed) return [];
  const prefix = typed[1].toLowerCase();
  return PROMPT_ENTRIES.filter((entry) => entry.word.startsWith(prefix));
}

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

function readNarrow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;
}

const wideOnServer = () => false;

/** Hands the dock the link just captured; the dock watches it settle. */
function announcePending(itemId: number) {
  window.dispatchEvent(new CustomEvent("sb:capture-pending", { detail: { itemId } }));
}

/**
 * One line for everything: a note, a link, a task, or a search. The intent is read from what
 * is typed, so there are no modes to switch between. It is the dock's expanded state: the
 * dock opens it and takes it back once the line has been sent.
 */
export function PromptBar({
  open,
  onClose,
  initialValue = "",
  onDraftChange,
}: {
  open: boolean;
  onClose(): void;
  /** What was left in the field last time; the dock keeps it while the bar is away. */
  initialValue?: string;
  onDraftChange?(value: string): void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const container = useCurrentContainer();
  const planDate = usePlanDate();
  const { captureNote, captureLink, uploadFiles } = useCapture();
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, wideOnServer);
  const [text, setText] = useState(initialValue);
  const [multiline, setMultiline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const prevMultiline = useRef(multiline);
  const containerId = container?.id ?? null;

  /** The only way the field's value changes, so the dock's copy of it stays in step. */
  const write = useCallback(
    (value: string) => {
      setText(value);
      onDraftChange?.(value);
    },
    [onDraftChange],
  );

  const submit = useCallback(async () => {
    if (busy || !text.trim()) return;
    const current = detectIntent(text);
    if (current.kind === "search") {
      if (!current.query) {
        setError("Type something to search");
        return;
      }
      router.push(`/search?q=${encodeURIComponent(current.query)}`);
      write("");
      setError(null);
      onClose();
      return;
    }
    if (current.kind === "task" && !current.title) {
      setError("Add a task title");
      return;
    }
    if (current.kind === "note" && !current.body) {
      setError("Type a note");
      return;
    }
    if (current.kind === "link" && !current.url) {
      setError("Type a link");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (current.kind === "task") {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            title: current.title,
            priority: current.priority,
            dueDate: current.dueDate,
            estimateMinutes: current.estimateMinutes,
            ...(current.sessionMinutes !== null ? { sessionMinutes: current.sessionMinutes } : {}),
            ...(current.requesterHandle ? { requesterHandle: current.requesterHandle } : {}),
            containerId,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? res.statusText);
        }
        const task = (await res.json()) as TaskDTO;
        // With a plan open the task belongs on it too. A refused plan write is reported, but the
        // task itself already landed, so it stays and the toast still says so.
        let planError: string | null = null;
        if (planDate !== null) {
          const planned = await fetch("/api/plan", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ date: planDate, taskId: task.id }) });
          if (planned.ok) window.dispatchEvent(new Event("sb:plan-changed"));
          else {
            const data = (await planned.json().catch(() => null)) as { error?: string } | null;
            planError = data?.error ?? planned.statusText;
          }
        }
        const addedText = planDate === null || planError ? "Task added" : planDate === todayLocal() ? "Task added to today's plan" : "Task added and planned";
        toast.push({
          text: addedText,
          action: {
            label: "Undo",
            onClick: () => {
              void (async () => {
                const undone = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
                if (undone.ok) {
                  window.dispatchEvent(new Event("sb:tasks-changed"));
                  if (planDate !== null) window.dispatchEvent(new Event("sb:plan-changed"));
                }
              })();
            },
          },
        });
        window.dispatchEvent(new Event("sb:tasks-changed"));
        if (planError) {
          // The line stays on screen with what was typed, the same as a refused capture.
          setError(planError);
          return;
        }
      } else if (current.kind === "note") {
        const item = await captureNote(current.body, { containerId });
        toast.push({ text: container ? `Captured to ${container.name}` : "Captured to Inbox", href: `/items/${item.id}` });
        window.dispatchEvent(new Event("sb:inbox-changed"));
      } else {
        const item = await captureLink(current.url, { containerId });
        if ("duplicate" in item) {
          // Nothing was written, so nothing needs re-reading.
          toast.push({ text: "Already captured", href: `/items/${item.duplicate}` });
        } else {
          toast.push({ text: container ? `Link captured to ${container.name}` : "Link captured", href: `/items/${item.id}` });
          announcePending(item.id);
          window.dispatchEvent(new Event("sb:inbox-changed"));
        }
      }
      write("");
      setMultiline(false);
      setMenuOpen(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, text, container, containerId, planDate, router, toast, captureNote, captureLink, onClose, write]);

  const sendFiles = useCallback(
    async (files: File[]) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const created = await uploadFiles(files, { containerId });
        toast.push({ text: `${created.length} file${created.length === 1 ? "" : "s"} captured` });
        window.dispatchEvent(new Event("sb:inbox-changed"));
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, uploadFiles, containerId, toast, onClose],
  );

  // `shortcuts.tsx` owns the `c` key and calls the bar with this event.
  useEffect(() => {
    function onRequest() {
      fieldRef.current?.focus();
    }
    window.addEventListener("sb:prompt-focus", onRequest);
    return () => window.removeEventListener("sb:prompt-focus", onRequest);
  }, []);

  // Growing into a textarea (or shrinking back) swaps the element, which drops focus to the
  // body; put the caret back where the typing left off. Only an actual swap does that, so the
  // effect compares against the previous value rather than tracking whether it has run before:
  // a mount runs the effect too, and a first-run guard that only flips a flag still leaves
  // every later re-run (React 19 remounts, Strict Mode's double invoke) stealing focus from
  // the page the bar sits over.
  useEffect(() => {
    if (prevMultiline.current === multiline) return;
    prevMultiline.current = multiline;
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [multiline]);

  if (!open || pathname === "/capture") return null;

  const intent = detectIntent(text);
  const mode = MODE[intent.kind];
  const empty = text.trim().length === 0;
  const menuEntries = menuOpen ? matchingEntries(text) : [];
  const activeIndex = Math.min(menuIndex, Math.max(0, menuEntries.length - 1));
  const placeholder = narrow ? "Ask or capture" : LABEL;

  function choose(entry: PromptEntry) {
    write(`/${entry.word} `);
    setMenuOpen(false);
    fieldRef.current?.focus();
  }

  function onChange(value: string) {
    write(value);
    setError(null);
    setMenuIndex(0);
    setMenuOpen(matchingEntries(value).length > 0);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (menuEntries.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % menuEntries.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + menuEntries.length) % menuEntries.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        choose(menuEntries[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // The dock keeps whatever is typed, so Escape can put the pill back without losing it.
      onClose();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.shiftKey) {
      // The single line grows into a box; inside the box Shift+Enter is a newline.
      if (!multiline) {
        e.preventDefault();
        setMultiline(true);
      }
      return;
    }
    e.preventDefault();
    void submit();
  }

  function onPaste(e: ReactClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const pasted = Array.from(e.clipboardData.files);
    if (!pasted.length) return;
    e.preventDefault();
    void sendFiles(pasted);
  }

  function onDropFiles(e: DragEvent<HTMLDivElement>) {
    const dropped = Array.from(e.dataTransfer.files);
    if (!dropped.length) return;
    e.preventDefault();
    void sendFiles(dropped);
  }

  return (
    <form
      aria-label={LABEL}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="relative"
    >
      {menuEntries.length > 0 && <PromptMenu entries={menuEntries} activeIndex={activeIndex} onChoose={choose} />}
      <div
        onDrop={onDropFiles}
        onDragOver={(e) => e.preventDefault()}
        className="panel relative rounded-lg flex items-start gap-2 px-2.5 py-2 min-h-14"
      >
        <span className="shrink-0 mt-0.5 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-hairline text-[12px] text-fg-muted">
          <mode.icon className="w-3.5 h-3.5" aria-hidden />
          {mode.label}
          {/* The parser's reading of "~25m" or "~2h/45m", so the size is seen before the task is filed. */}
          {intent.kind === "task" && intent.estimateMinutes !== null && (
            <span className="font-mono text-[11px] text-fg-faint">
              ~{formatMinutes(intent.estimateMinutes)}
              {intent.sessionMinutes !== null && ` · ${formatMinutes(intent.sessionMinutes)} sessions`}
            </span>
          )}
        </span>
        {multiline ? (
          <textarea
            ref={fieldRef as RefObject<HTMLTextAreaElement>}
            value={text}
            aria-label={LABEL}
            placeholder={placeholder}
            rows={Math.min(MAX_ROWS, text.split("\n").length || 1)}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className={`${FIELD} resize-none py-1 leading-relaxed`}
          />
        ) : (
          <input
            ref={fieldRef as RefObject<HTMLInputElement>}
            type="text"
            value={text}
            aria-label={LABEL}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className={`${FIELD} h-8`}
          />
        )}
        <span className="shrink-0 mt-0.5 flex items-center gap-2">
          <Kbd>⏎</Kbd>
          <button
            type="submit"
            aria-label="Send"
            disabled={empty || busy}
            className="focus-ring bg-violet text-on-violet rounded-full w-8 h-8 inline-flex items-center justify-center transition-opacity duration-150 disabled:opacity-40"
          >
            <ArrowUp className="w-4 h-4" aria-hidden />
          </button>
        </span>
      </div>
      {error && (
        <p className="relative mt-1.5 flex items-center gap-3 text-[12.5px] text-danger">
          {error}
          <button type="button" onClick={() => void submit()} className="focus-ring rounded-sm text-fg-muted hover:text-fg">
            Retry
          </button>
        </p>
      )}
    </form>
  );
}
