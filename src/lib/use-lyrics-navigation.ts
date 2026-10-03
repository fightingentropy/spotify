import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

export function useLyricsNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const lyricsOpen = location.pathname === "/lyrics";
  const openedFromApp = Boolean(location.state?.lyricsFrom);

  const closeLyrics = useCallback(() => {
    if (openedFromApp) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate, openedFromApp]);

  const openLyrics = () => {
    if (lyricsOpen) return;
    navigate("/lyrics", { state: { lyricsFrom: `${location.pathname}${location.search}${location.hash}` } });
  };

  return { lyricsOpen, openLyrics, closeLyrics };
}
