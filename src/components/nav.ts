export type IconName = "home" | "planner" | "inbox" | "goal" | "review" | "log" | "project" | "area" | "resource" | "people" | "activity" | "library" | "archive" | "search" | "capture" | "help" | "desk" | "settings";

export interface NavItem {
  href: string;
  label: string;
  shortcut: string;
  icon: IconName;
  badge?: "inbox" | "activity" | "desk";
  section: "brain" | "tools";
}

/** Order is the dock order. Every entry has a `g` + letter shortcut. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", shortcut: "g h", icon: "home", section: "brain" },
  // "desK": `g d` belongs to the Planner, and the desk earns a place beside it — Home is the
  // quick view of everything, this is where things get decided.
  { href: "/desk", label: "Desk", shortcut: "g k", icon: "desk", badge: "desk", section: "brain" },
  { href: "/planner", label: "Planner", shortcut: "g d", icon: "planner", section: "brain" },
  { href: "/goals", label: "Goals", shortcut: "g g", icon: "goal", section: "brain" },
  { href: "/review", label: "Review", shortcut: "g w", icon: "review", section: "brain" },
  { href: "/log", label: "Log", shortcut: "g o", icon: "log", section: "brain" },
  { href: "/inbox", label: "Inbox", shortcut: "g i", icon: "inbox", badge: "inbox", section: "brain" },
  { href: "/projects", label: "Projects", shortcut: "g p", icon: "project", section: "brain" },
  { href: "/areas", label: "Areas", shortcut: "g a", icon: "area", section: "brain" },
  { href: "/resources", label: "Resources", shortcut: "g r", icon: "resource", section: "brain" },
  { href: "/people", label: "People", shortcut: "g e", icon: "people", section: "brain" },
  { href: "/activity", label: "Activity", shortcut: "g t", icon: "activity", badge: "activity", section: "tools" },
  { href: "/library", label: "Library", shortcut: "g l", icon: "library", section: "tools" },
  { href: "/archive", label: "Archive", shortcut: "g x", icon: "archive", section: "tools" },
  { href: "/settings", label: "Settings", shortcut: "g ,", icon: "settings", section: "tools" },
  { href: "/help", label: "Help", shortcut: "g u", icon: "help", section: "tools" },
];

/** Search and Capture are dock buttons rather than links, and keep their shortcuts and palette entries. */
export const SEARCH_ITEM: NavItem = { href: "/search", label: "Search", shortcut: "g s", icon: "search", section: "tools" };
export const CAPTURE_ITEM: NavItem = { href: "/capture", label: "Capture", shortcut: "g c", icon: "capture", section: "tools" };

/**
 * Whether a nav entry owns the open page. Home is the one href that is a prefix of every other,
 * so it matches only itself; the rest also claim what sits under them.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
