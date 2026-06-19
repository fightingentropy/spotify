import CrossfadeSettings from "@/components/CrossfadeSettings";

export default function SettingsPage() {
  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-3xl space-y-8">
        <h1 className="mb-6 text-2xl font-semibold">Settings</h1>
        <CrossfadeSettings />
      </div>
    </div>
  );
}
