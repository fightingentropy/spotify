export type QueueEditState<T> = {
  queue: T[];
  currentIndex: number;
  playHistory: number[];
  playFuture: number[];
  shuffleRemaining: number[];
  shuffle: boolean;
};

export function moveUpcomingSong<T>(state: QueueEditState<T>, upcoming: readonly number[], from: number, to: number) {
  const start = upcoming.indexOf(from);
  const end = upcoming.indexOf(to);
  if (start < 0 || end < 0 || start === end || upcoming.includes(state.currentIndex)) return null;
  const order = [...upcoming];
  order.splice(end, 0, order.splice(start, 1)[0]);
  const mapping = state.queue.map((_, index) => index);
  const queue = [...state.queue];
  upcoming.forEach((slot, position) => {
    queue[slot] = state.queue[order[position]];
    mapping[order[position]] = slot;
  });
  return {
    queue,
    playHistory: state.playHistory.map((index) => mapping[index]),
    playFuture: state.shuffle ? [] : state.playFuture.map((index) => mapping[index]),
    shuffleRemaining: state.shuffle ? [...upcoming] : state.shuffleRemaining.map((index) => mapping[index]),
    mapping,
  };
}

export type QueueRemoval<T> = {
  song: T;
  index: number;
  nextId?: string;
  previousId?: string;
  nextPlaybackId?: string;
  playbackPosition: number;
  originalCount: number;
};

export function rememberQueueRemoval<T extends { id: string }>(state: QueueEditState<T>, upcoming: readonly number[], index: number): QueueRemoval<T> {
  const position = upcoming.indexOf(index);
  return {
    song: state.queue[index], index,
    previousId: state.queue[index - 1]?.id,
    nextId: state.queue[index + 1]?.id,
    nextPlaybackId: position >= 0 ? state.queue[upcoming[position + 1]]?.id : undefined,
    playbackPosition: position,
    originalCount: state.queue.filter((song) => song.id === state.queue[index].id).length,
  };
}

export function restoreQueueRemoval<T extends { id: string }>(state: QueueEditState<T>, upcoming: readonly number[], removed: QueueRemoval<T>) {
  if (state.queue.filter((song) => song.id === removed.song.id).length >= removed.originalCount) return null;
  const next = state.queue.findIndex((song) => song.id === removed.nextId);
  const previous = state.queue.findIndex((song) => song.id === removed.previousId);
  const at = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(removed.index, state.queue.length);
  const queue = [...state.queue];
  queue.splice(at, 0, removed.song);
  const remap = (index: number) => index >= at ? index + 1 : index;
  const order = upcoming.map(remap);
  const following = order.findIndex((index) => queue[index].id === removed.nextPlaybackId);
  order.splice(following >= 0 ? following : Math.max(0, Math.min(removed.playbackPosition, order.length)), 0, at);
  return {
    queue, index: at, remap,
    currentIndex: remap(state.currentIndex),
    playHistory: state.playHistory.map(remap),
    playFuture: state.shuffle ? [] : state.playFuture.map(remap),
    shuffleRemaining: state.shuffle ? order : state.shuffleRemaining.map(remap),
  };
}
