import { useState, useRef, useCallback } from "react";

const SCROLL_THRESHOLD = 100; // 像素

interface UseScrollOptions {
  threshold?: number;
}

export function useScroll(options: UseScrollOptions = {}) {
  const threshold = options.threshold ?? SCROLL_THRESHOLD;
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  // 判断用户是否在页面底部
  const isNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, [threshold]);

  // 滚动到容器底部
  const scrollToBottom = useCallback(() => {
    if (!autoScrollEnabled) return;

    const container = containerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [autoScrollEnabled]);

  // 处理用户滚动事件
  const handleScroll = useCallback(() => {
    if (isNearBottom()) {
      setAutoScrollEnabled(true);
    } else {
      setAutoScrollEnabled(false);
    }
  }, [isNearBottom]);

  return {
    containerRef,
    autoScrollEnabled,
    setAutoScrollEnabled,
    handleScroll,
    scrollToBottom,
    isNearBottom,
  };
}
