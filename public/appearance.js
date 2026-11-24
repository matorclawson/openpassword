// Set the palette before first paint, including on direct message links.
(() => {
  const key = "openpassword.appearance";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let choice = "system";
  function apply(value) {
    choice = value === "light" || value === "dark" ? value : "system";
    document.documentElement.dataset.appearance = choice;
    document.documentElement.dataset.palette = choice === "system" ? (media.matches ? "dark" : "light") : choice;
  }
  try { apply(localStorage.getItem(key)); } catch { apply("system"); }
  media.addEventListener("change", () => apply(choice));
  window.addEventListener("storage", event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
  window.addEventListener("openpassword-appearance", event => {
    apply(event.detail);
    try { localStorage.setItem(key, choice); } catch { /* Use the in-memory selection. */ }
  });
})();
