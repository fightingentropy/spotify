import CrossfadeSettings from "@/components/CrossfadeSettings";
import { PageHeader, PageLayout } from "@/components/PageLayout";

export default function SettingsPage() {
  return (
    <PageLayout narrow>
      <PageHeader title="Settings" />
      <CrossfadeSettings />
    </PageLayout>
  );
}
