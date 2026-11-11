import {
  House,
  CalendarCheck,
  ClipboardList,
  Inbox,
  Target,
  RotateCcw,
  Ruler,
  Flag,
  Layers,
  BookMarked,
  Users,
  Activity,
  LayoutList,
  Archive,
  Search,
  Plus,
  CircleHelp,
  Settings,
  Table,
  type LucideIcon,
} from "lucide-react";
import type { IconName } from "./nav";

const ICONS: Record<IconName, LucideIcon> = {
  home: House,
  desk: ClipboardList,
  settings: Settings,
  planner: CalendarCheck,
  inbox: Inbox,
  goal: Target,
  review: RotateCcw,
  log: Ruler,
  project: Flag,
  area: Layers,
  resource: BookMarked,
  people: Users,
  activity: Activity,
  library: LayoutList,
  archive: Archive,
  search: Search,
  capture: Plus,
  help: CircleHelp,
  tracker: Table,
};

export function Icon({ name, className = "w-5 h-5" }: { name: IconName; className?: string }) {
  const Cmp = ICONS[name];
  return <Cmp className={className} strokeWidth={1.75} aria-hidden />;
}
