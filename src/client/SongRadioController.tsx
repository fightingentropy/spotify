import { useEffect } from "react";
import { useAuth } from "@/client/auth";
import { startSongRadioController } from "@/client/song-radio";

export function SongRadioController(): null {
  const { user, status } = useAuth();
  useEffect(() => {
    if (status !== "loading") return startSongRadioController();
  }, [user?.id, status]);
  return null;
}
