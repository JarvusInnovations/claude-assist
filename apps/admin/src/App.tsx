import { Routes, Route } from "react-router";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/sonner";

// Pages
import { DashboardPage } from "@/pages/DashboardPage";
import { AccountsPage } from "@/pages/AccountsPage";
import { AccountDetailPage } from "@/pages/AccountDetailPage";
import { EmailsPage } from "@/pages/EmailsPage";
import { EmailDetailPage } from "@/pages/EmailDetailPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { SessionDetailPage } from "@/pages/SessionDetailPage";
import { ActivityPage } from "@/pages/ActivityPage";
import { SystemPage } from "@/pages/SystemPage";
import { InboxPage } from "@/pages/InboxPage";
import { CapturesPage } from "@/pages/CapturesPage";
import { PagesPage } from "@/pages/PagesPage";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { BriefingPage } from "@/pages/BriefingPage";
import { DigestPage } from "@/pages/DigestPage";
import { UrgencyPage } from "@/pages/UrgencyPage";
import { ClassificationPage } from "@/pages/ClassificationPage";

function App() {
  return (
    <>
      <Routes>
        <Route
          path="/"
          element={
            <SidebarProvider>
              <AppSidebar />
              <AppShell />
            </SidebarProvider>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="captures" element={<CapturesPage />} />
          <Route path="pages" element={<PagesPage />} />
          <Route path="digest" element={<DigestPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="briefing" element={<BriefingPage />} />
          <Route path="urgency" element={<UrgencyPage />} />
          <Route path="classification" element={<ClassificationPage />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="accounts/:id" element={<AccountDetailPage />} />
          <Route path="emails" element={<EmailsPage />} />
          <Route path="emails/:id" element={<EmailDetailPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="sessions/activity" element={<ActivityPage />} />
          <Route path="sessions/:id" element={<SessionDetailPage />} />
          <Route path="system" element={<SystemPage />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}

export default App;
