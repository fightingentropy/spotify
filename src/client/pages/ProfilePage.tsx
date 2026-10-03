import { Link, Navigate, useNavigate } from "react-router";
import { useRef, useState } from "react";
import { BarChart3, Camera, Loader2, LogOut, Settings } from "lucide-react";
import { useAuth } from "@/client/auth";
import { AccountAvatar } from "@/components/AuthButtons";
import { PageError } from "@/components/PageError";
import { PageHeader, PageLayout } from "@/components/PageLayout";

export default function ProfilePage() {
  const { user, status, signOut, updateProfileImage } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  if (status === "loading") {
    return (
      <PageLayout narrow>
        <PageHeader title="Profile" />
        <p className="wf-muted" role="status">Loading profile...</p>
      </PageLayout>
    );
  }

  if (!user) return <Navigate to="/signin" replace />;

  const displayName = user.name || "Profile";

  async function handleProfileImageChange(file: File | undefined) {
    if (!file || uploadingImage) return;
    setUploadingImage(true);
    setImageError(null);
    try {
      await updateProfileImage(file);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "Failed to update profile image");
    } finally {
      setUploadingImage(false);
    }
  }

  return (
    <PageLayout narrow>
      <PageHeader title="Profile" />
      <div className="wf-panel flex items-center gap-5 p-5">
        <div className="relative h-20 w-20 shrink-0">
          <AccountAvatar
            src={user.image}
            alt={displayName}
            className="h-20 w-20 rounded-full border border-white/10 object-cover"
            iconSize={32}
            size={80}
          />
          <button
            type="button"
            aria-label="Change profile image"
            title="Change profile image"
            disabled={uploadingImage}
            onClick={() => fileInputRef.current?.click()}
            className="wf-icon-button absolute -bottom-1 -right-1"
            style={{ background: "var(--surface)" }}
          >
            {uploadingImage ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            aria-label="Profile image file"
            className="sr-only"
            onChange={(event) => {
              void handleProfileImageChange(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </div>
        <div className="min-w-0">
          <h2 className="wf-section-title truncate">{displayName}</h2>
          <p className="wf-muted mt-1 truncate text-sm">{user.email}</p>
          {imageError ? <div className="mt-2"><PageError compact message={imageError} /></div> : null}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          to="/listening-stats"
          className="wf-button"
        >
          <BarChart3 size={19} />
          <span>Listening stats</span>
        </Link>
        <Link
          to="/settings"
          className="wf-button"
        >
          <Settings size={19} />
          <span>Settings</span>
        </Link>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            navigate("/");
          }}
          className="wf-button"
        >
          <LogOut size={19} />
          <span>Sign out</span>
        </button>
      </div>
    </PageLayout>
  );
}
