// Drag preview utilities for file drag and drop

const PREVIEW_WIDTH_SCALE = 0.5;
const PREVIEW_HEIGHT_SCALE = 0.75;

const transparentImage = new Image();
transparentImage.src =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

let dragPreviewEl: HTMLDivElement | null = null;

export const animateFlyToFolder = async (ids: string[], folderId: string) => {
  if (ids.length === 0) return;
  const target = document.querySelector<HTMLElement>(
    `[data-file-id="${folderId}"]`,
  );
  const first = document.querySelector<HTMLElement>(
    `[data-file-id="${ids[0]}"]`,
  );
  if (!target || !first) return;
  const targetRect = target.getBoundingClientRect();
  const startRect = first.getBoundingClientRect();

  const wrapper = document.createElement("div");
  wrapper.className = "drag-preview";
  wrapper.style.position = "fixed";
  wrapper.style.pointerEvents = "none";
  wrapper.style.top = `${startRect.top}px`;
  wrapper.style.left = `${startRect.left}px`;
  wrapper.style.width = `${startRect.width + 4 * (Math.min(ids.length, 3) - 1)}px`;
  wrapper.style.height = `${startRect.height + 4 * (Math.min(ids.length, 3) - 1)}px`;
  wrapper.style.transform = `scale(${PREVIEW_WIDTH_SCALE}, ${PREVIEW_HEIGHT_SCALE})`;
  wrapper.style.zIndex = "9999";
  wrapper.style.setProperty("--preview-scale-x", String(PREVIEW_WIDTH_SCALE));
  wrapper.style.setProperty("--preview-scale-y", String(PREVIEW_HEIGHT_SCALE));
  wrapper.style.setProperty("--badge-scale-x", String(1 / PREVIEW_WIDTH_SCALE));
  wrapper.style.setProperty(
    "--badge-scale-y",
    String(1 / PREVIEW_HEIGHT_SCALE),
  );

  const stack = document.createElement("div");
  stack.className = "preview-stack";
  wrapper.appendChild(stack);

  ids.slice(0, 3).forEach((id, idx) => {
    const el =
      document.querySelector<HTMLElement>(`[data-file-id="${id}"]`) ?? first;
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as HTMLElement;
    clone.classList.add("preview-item");
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.transform = `translate(${idx * 4}px, ${idx * 4}px)`;
    stack.appendChild(clone);
  });

  if (ids.length > 1) {
    const badge = document.createElement("div");
    badge.className = "preview-count";
    badge.textContent = String(ids.length);
    stack.appendChild(badge);
  }

  document.body.appendChild(wrapper);

  const deltaX = targetRect.left - startRect.left;
  const deltaY = targetRect.top - startRect.top;

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      wrapper.style.transition =
        "transform 0.3s ease-in-out, opacity 0.3s ease-in-out";
      wrapper.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${PREVIEW_WIDTH_SCALE * 0.5}, ${PREVIEW_HEIGHT_SCALE * 0.5})`;
      wrapper.style.opacity = "0";
      wrapper.addEventListener(
        "transitionend",
        () => {
          wrapper.remove();
          resolve();
        },
        { once: true },
      );
    });
  });
};

export const createDragPreview = (
  ids: string[],
  x: number,
  y: number,
  isMobile: boolean,
) => {
  removeDragPreview();
  if (ids.length === 0 || isMobile) return; // Disable drag preview on mobile
  const first = document.querySelector<HTMLElement>(
    `[data-file-id="${ids[0]}"]`,
  );
  if (!first) return;

  const wrapper = document.createElement("div");
  wrapper.className = "drag-preview";
  wrapper.style.position = "fixed";
  wrapper.style.pointerEvents = "none";
  wrapper.style.top = "0";
  wrapper.style.left = "0";
  wrapper.style.zIndex = "10000";

  // Compact chip
  const chip = document.createElement("div");
  chip.className = "drag-chip";

  // icon clone (SVG) – copy from card if available
  const iconSource = first.querySelector("svg");
  if (iconSource) {
    const icon = iconSource.cloneNode(true) as HTMLElement;
    icon.classList.add("drag-chip-icon");
    chip.appendChild(icon);
  }

  // name (single line)
  const name = first.querySelector("p");
  const nameText = name ? name.textContent || "" : "Selected";
  const nameEl = document.createElement("span");
  nameEl.className = "drag-chip-name";
  nameEl.textContent = nameText;
  chip.appendChild(nameEl);

  wrapper.appendChild(chip);

  if (ids.length > 1) {
    const count = document.createElement("div");
    count.className = "drag-chip-count";
    count.textContent = String(ids.length);
    wrapper.appendChild(count);
  }

  document.body.appendChild(wrapper);
  dragPreviewEl = wrapper as HTMLDivElement;
  moveDragPreview(x, y);
};

export const moveDragPreview = (x: number, y: number) => {
  if (dragPreviewEl) {
    dragPreviewEl.style.transform = `translate(${x + 16}px, ${y + 16}px) scale(${PREVIEW_WIDTH_SCALE}, ${PREVIEW_HEIGHT_SCALE})`;
  }
};

export const removeDragPreview = () => {
  if (dragPreviewEl) {
    dragPreviewEl.remove();
    dragPreviewEl = null;
  }
};

export const getTransparentImage = () => transparentImage;
