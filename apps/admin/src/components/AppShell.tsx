import { Outlet } from "react-router";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

export function AppShell() {
  return (
    <div className="flex-1 flex flex-col h-screen bg-background">
      <header className="flex h-14 items-center gap-4 border-b bg-background px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-6" />
        <div className="flex-1" />
      </header>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
