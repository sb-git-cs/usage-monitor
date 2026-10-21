// Covers the screen behind a floating flyout: a click anywhere else hides it. The faint
// background keeps the window hit-testable; a fully transparent one lets clicks through.
for (const el of [document.documentElement, document.body]) {
  Object.assign(el.style, { margin: "0", width: "100%", height: "100%", background: "rgba(0,0,0,0.02)" });
}
document.addEventListener("mousedown", (e) => {
  e.preventDefault();
  window.usage.hideFlyout();
});
