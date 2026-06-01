import { Link, Navigate, useNavigate } from "react-router-dom";
import { LogOut, Settings } from "lucide-react";
import { useAuth } from "@/client/auth";
import { AccountAvatar } from "@/components/AuthButtons";

export default function ProfilePage() {
  const { user, status, signOut } = useAuth();
  const navigate = useNavigate();

  if (status === "loading") {
    return (
      <div className="px-4 py-8 text-white sm:px-6 lg:px-10">
        <div className="opacity-70">Loading profile...</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/signin" replace />;

  const displayName = user.name || "Profile";

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-10">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-5 border-b border-white/[0.1] pb-7">
          <AccountAvatar
            src={user.image}
            alt={displayName}
            className="h-24 w-24 rounded-full border border-white/[0.14] object-cover shadow-[0_16px_36px_rgba(0,0,0,0.35)]"
            iconSize={42}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-white/[0.48]">Profile</p>
            <h1 className="mt-1 truncate text-3xl font-semibold sm:text-4xl">{displayName}</h1>
            <p className="mt-2 truncate text-[15px] text-white/[0.64]">{user.email}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            to="/settings"
            className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-white/[0.78] transition hover:bg-white/[0.07] hover:text-white"
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
            className="flex min-h-14 items-center gap-3 rounded-md border border-white/[0.12] px-4 text-left text-white/[0.78] transition hover:bg-white/[0.07] hover:text-white"
          >
            <LogOut size={19} />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
