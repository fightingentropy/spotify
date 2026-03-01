import CrossfadeSettings from "@/components/CrossfadeSettings";
import LocalMediaSettings from "@/components/LocalMediaSettings";

export default function SettingsPage() {
  return (
    <div className="px-6 py-8 max-w-3xl mx-auto space-y-8">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <CrossfadeSettings />
      <LocalMediaSettings />
    </div>
  );
}

