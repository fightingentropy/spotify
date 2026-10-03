import { X } from "lucide-react";
import { useLikesStore } from "@/store/likes";

export function LikeFeedback() {
  const error = useLikesStore((state) => state.error);
  const clearError = useLikesStore((state) => state.clearError);
  if (!error) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-[calc(var(--wf-mobile-nav-bottom-offset)+var(--wf-mobile-player-height)+2rem)] z-[100] mx-auto flex max-w-md items-center gap-3 rounded-lg border border-white/15 bg-[#202020] py-3 pl-4 pr-2 text-sm text-white shadow-xl lg:bottom-28"
    >
      <span className="flex-1">{error}</span>
      <button
        type="button"
        aria-label="Dismiss like error"
        onClick={clearError}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-white/10 focus-visible:outline focus-visible:outline-white"
      >
        <X size={18} />
      </button>
    </div>
  );
}
