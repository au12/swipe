// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('sw.theme');
  } catch (e) {}
  var dark = saved ? saved === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // The browser's own chrome (and an installed app's status bar) takes the table's color.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#1a1714' : '#e3e1da';
})();
