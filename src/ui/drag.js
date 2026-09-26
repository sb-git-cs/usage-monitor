function bindDrag(root, skipSelector) {
  let active = false;
  const skip = skipSelector || "button, select, a, .icon-btn, .interval, .pct-icon, .tb-item, .provider, .net-card";

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(skip)) return;
    active = true;
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.usage.dragBegin(e.screenX, e.screenY);
    e.preventDefault();
  });

  root.addEventListener("pointermove", (e) => {
    if (!active) return;
    window.usage.dragTo(e.screenX, e.screenY);
  });

  const end = () => {
    if (!active) return;
    active = false;
    window.usage.dragEnd();
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
}
