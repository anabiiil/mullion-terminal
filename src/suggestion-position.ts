interface PopupGeometry {
  width: number;
  height: number;
  cursorLeft: number;
  cursorTop: number;
  cursorBottom: number;
  popupWidth: number;
  popupHeight: number;
}

/** Position relative to the visible terminal, preferring the space below input. */
export function suggestionPosition(geometry: PopupGeometry) {
  const margin = 8;
  const gap = 5;
  const { width, height, cursorLeft, cursorTop, cursorBottom, popupWidth, popupHeight } = geometry;
  if (cursorTop < 0 || cursorBottom > height || width <= margin * 2 || height <= margin * 2) return null;
  const below = Math.max(0, height - margin - cursorBottom - gap);
  const above = Math.max(0, cursorTop - gap - margin);
  const opensBelow = below >= popupHeight || (above < popupHeight && below >= above);
  const maxHeight = Math.min(popupHeight, opensBelow ? below : above);
  if (maxHeight < 1) return null;
  return {
    left: Math.max(margin, Math.min(cursorLeft, width - popupWidth - margin)),
    top: opensBelow ? cursorBottom + gap : cursorTop - gap - maxHeight,
    maxHeight,
    placement: opensBelow ? 'below' as const : 'above' as const,
  };
}
