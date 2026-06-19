import { NowPlayingSheet } from "@/components/player/NowPlayingSheet";
import { QueueSheet } from "@/components/player/QueueSheet";
import { TrackActionsMenu } from "@/components/player/TrackActionsMenu";
import { SleepTimerSheet } from "@/components/player/SleepTimerSheet";
import { CreateMenuSheet } from "@/components/player/CreateMenuSheet";
import { LibraryActionsMenu } from "@/components/library/LibraryActionsMenu";
import { LibrarySortMenu } from "@/components/library/LibrarySortMenu";
import { useUiStore } from "@/store/ui";

// Hosts the global bottom sheets, each controlled by the ui-store booleans.
// Mounted once in the root layout.
export function PlayerSheets() {
  const nowPlayingOpen = useUiStore((s) => s.nowPlayingOpen);
  const queueOpen = useUiStore((s) => s.queueOpen);
  const trackActions = useUiStore((s) => s.trackActions);
  const libraryActions = useUiStore((s) => s.libraryActions);
  const sleepTimerOpen = useUiStore((s) => s.sleepTimerOpen);
  const createMenuOpen = useUiStore((s) => s.createMenuOpen);
  const librarySortOpen = useUiStore((s) => s.librarySortOpen);

  const closeNowPlaying = useUiStore((s) => s.closeNowPlaying);
  const closeQueue = useUiStore((s) => s.closeQueue);
  const closeTrackActions = useUiStore((s) => s.closeTrackActions);
  const closeLibraryActions = useUiStore((s) => s.closeLibraryActions);
  const closeSleepTimer = useUiStore((s) => s.closeSleepTimer);
  const closeCreateMenu = useUiStore((s) => s.closeCreateMenu);
  const closeLibrarySort = useUiStore((s) => s.closeLibrarySort);

  return (
    <>
      <NowPlayingSheet visible={nowPlayingOpen} onClose={closeNowPlaying} />
      <QueueSheet visible={queueOpen} onClose={closeQueue} />
      <TrackActionsMenu visible={!!trackActions} onClose={closeTrackActions} />
      <LibraryActionsMenu visible={!!libraryActions} onClose={closeLibraryActions} />
      <LibrarySortMenu visible={librarySortOpen} onClose={closeLibrarySort} />
      <SleepTimerSheet visible={sleepTimerOpen} onClose={closeSleepTimer} />
      <CreateMenuSheet visible={createMenuOpen} onClose={closeCreateMenu} />
    </>
  );
}
