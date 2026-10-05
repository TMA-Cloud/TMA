import React from 'react';
import { useMarqueeSelection, type MarqueeSelectorProps } from './hooks/useMarqueeSelection';

export const MarqueeSelector: React.FC<MarqueeSelectorProps> = ({ children, ...props }) => {
  const { containerRef, isSelecting, selectionRect, handleMouseDown } = useMarqueeSelection(props);
  // The crosshair only appears once a rectangle is actually being drawn.
  // Wearing it the whole time the pointer is over the file area would say
  // "you are selecting" when the user is just looking.
  return (
    <div
      ref={containerRef}
      className={`relative select-none overflow-visible ${isSelecting ? 'cursor-crosshair' : ''}`}
      onMouseDown={handleMouseDown}
    >
      {children}
      {isSelecting && selectionRect && (
        <div
          className="marquee-selection pointer-events-none"
          style={{
            left: `${selectionRect.left}px`,
            top: `${selectionRect.top}px`,
            width: `${selectionRect.width}px`,
            height: `${selectionRect.height}px`,
            zIndex: 10,
          }}
        >
          {/* Inner glow layer */}
          <div className="marquee-glow" />
          {/* Marching ants border */}
          <div className="marquee-border" />
          {/* Corner accents */}
          <div className="marquee-corner marquee-corner-tl" />
          <div className="marquee-corner marquee-corner-tr" />
          <div className="marquee-corner marquee-corner-bl" />
          <div className="marquee-corner marquee-corner-br" />
        </div>
      )}
    </div>
  );
};
