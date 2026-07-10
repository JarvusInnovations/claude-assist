import { useLocation, Link } from "react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  Inbox,
  Users,
  Mail,
  ScrollText,
  Settings,
  Layers,
  Bell,
  CalendarClock,
  Zap,
  Tags,
} from "lucide-react";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/inbox", label: "Inbox", icon: Inbox },
  { path: "/captures", label: "Captures", icon: Layers },
  { path: "/notifications", label: "Notifications", icon: Bell },
  { path: "/briefing", label: "Briefing", icon: CalendarClock },
  { path: "/urgency", label: "Slack Urgency", icon: Zap },
  { path: "/classification", label: "Classification", icon: Tags },
  { path: "/accounts", label: "Accounts", icon: Users },
  { path: "/emails", label: "Emails", icon: Mail },
  { path: "/sessions", label: "Sessions", icon: ScrollText },
  { path: "/system", label: "System", icon: Settings },
];

export function AppSidebar() {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === "/") {
      return location.pathname === "/";
    }
    return location.pathname.startsWith(path);
  };

  return (
    <Sidebar>
      <SidebarHeader className="border-b px-4 py-4">
        <span className="font-semibold text-lg">Claude Assist</span>
        <span className="text-xs text-muted-foreground">Admin</span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton asChild isActive={isActive(item.path)}>
                    <Link to={item.path}>
                      <item.icon className="mr-2 h-4 w-4" />
                      {item.label}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
