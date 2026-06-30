import { useEffect, useRef, useState } from "react";

import { type BridgeEvent, subscribeBridgeEvents } from "../lib/bridge";

export interface LiveEvent extends BridgeEvent {
  id: number;
}

let counter = 0;

export function useBridgeEvents(max = 500): {
  events: LiveEvent[];
  clear: () => void;
  paused: boolean;
  togglePause: () => void;
} {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const subscribed = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (subscribed.current) return;
    subscribed.current = true;
    let unsubscribe: (() => void) | null = null;
    subscribeBridgeEvents((event) => {
      if (pausedRef.current) return;
      setEvents((prev) => {
        const next = [...prev, { ...event, id: ++counter }];
        return next.length > max ? next.slice(next.length - max) : next;
      });
    })
      .then((off) => {
        unsubscribe = off;
      })
      .catch(() => {
        subscribed.current = false;
      });
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [max]);

  return {
    events,
    clear: () => setEvents([]),
    paused,
    togglePause: () => setPaused((v) => !v),
  };
}
