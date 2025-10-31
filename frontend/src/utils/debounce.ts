import { useCallback, useEffect, useRef, useState } from "react";

// Generic debounce function
export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      func(...args);
    }, wait);
  };
}

// Hook for debounced callbacks
export function useDebouncedCallback<T extends (...args: unknown[]) => unknown>(
  callback: T,
  delay: number,
): (...args: Parameters<T>) => void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const debouncedRef = useRef<((...args: Parameters<T>) => void) | null>(null);

  useEffect(() => {
    debouncedRef.current = debounce((...args: Parameters<T>) => {
      callbackRef.current(...args);
    }, delay);
  }, [delay]);

  return useCallback((...args: Parameters<T>) => {
    debouncedRef.current?.(...args);
  }, []);
}

// Promise queue to handle sequential async operations
export class PromiseQueue {
  private queue: (() => Promise<unknown>)[] = [];
  private running = false;

  async add<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.process();
    });
  }

  private async process() {
    if (this.running || this.queue.length === 0) {
      return;
    }

    this.running = true;

    while (this.queue.length > 0) {
      const operation = this.queue.shift()!;
      try {
        await operation();
      } catch (error) {
        console.error("Queue operation failed:", error);
      }
    }

    this.running = false;
  }
}

// Hook for promise queue
export function usePromiseQueue() {
  const [queue] = useState(() => new PromiseQueue());
  return queue;
}
