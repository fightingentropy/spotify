import CrossfadeSettings from "@/components/CrossfadeSettings";
import DownloadQualitySettings from "@/components/DownloadQualitySettings";
import EditModeSettings from "@/components/EditModeSettings";
import LocalMediaSettings from "@/components/LocalMediaSettings";

export default function SettingsPage() {
  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto space-y-8">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <LocalMediaSettings />
      <CrossfadeSettings />
      <EditModeSettings />
      <DownloadQualitySettings />
    </div>
  );
}
